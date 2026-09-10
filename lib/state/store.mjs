// Trantor State P1: the store (TDD §4.4). Where a WorkingState lives, how it is written untorn, and
// what a killed turn leaves behind. Deliberately NOT done here: journal replay (the journal is
// forensics; recovery reads git), a lock file (concurrency is CAS on `rev`), retrying STALE (the
// driver cures it). docs/CONTRACT-state.md.
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { busDir } from "../project.mjs";
import { CAPS, ERR, emptyState, stateError } from "./schema.mjs";
import { migrate } from "./migrate.mjs";

/** The CAS-conflict outcome. The one code this file owns; no branch of validate.mjs produces it. */
export const STALE = "STALE";

/** Journal ring size — accepted patches kept for forensics and test replay (TDD §4.4). */
export const JOURNAL_LINES = 200;

/** A sidecar for a card in a terminal status becomes collectable after this. */
export const GC_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Sanitise one path component as hooks/ask-sidecar.mjs does: outside [A-Za-z0-9._-] becomes `_`;
 * "", "." and ".." are rejected because they address a directory. @returns {string|null}
 */
export function sanitizeComponent(raw) {
  const s = String(raw ?? "").trim().replace(/[^A-Za-z0-9._-]/g, "_");
  if (!s || s === "." || s === "..") return null;
  return s;
}

/** `busDir()/state/<project>` — alongside asks/, handoffs/, claims/. */
export function stateDir(project) {
  const p = sanitizeComponent(project);
  return p ? join(busDir(), "state", p) : null;
}

/**
 * The sidecar path, per SEAT-CARD: a seat that switches cards must not inherit the previous
 * card's in-flight list. @returns {string|null}
 */
export function statePath(seat, card, project) {
  const dir = stateDir(project);
  const s = sanitizeComponent(seat);
  if (!dir || !s || !Number.isInteger(card) || card < 0) return null;
  return join(dir, `${s}--${card}.json`);
}

/** The ops journal that sits beside a sidecar. Forensics and test replay ONLY (TDD §4.4). */
export function opsPath(seat, card, project) {
  const p = statePath(seat, card, project);
  return p ? `${p.slice(0, -".json".length)}.ops.jsonl` : null;
}

/**
 * The cut marker the runner writes when the time box kills a turn. The runner uses homedir()
 * directly, so a run with AGENT_BUS_DIR set has to look in both places.
 */
export function turncutPaths(agent, project) {
  const a = sanitizeComponent(agent), p = sanitizeComponent(project);
  if (!a || !p) return [];
  const name = `turncut-${a}-${p}`;
  return [...new Set([join(busDir(), name), join(homedir(), ".agent-bus", name)])];
}

/** Atomic by the house pattern: write a temp in the SAME directory, then rename over the target. */
function writeAtomic(path, body) {
  const dir = path.slice(0, path.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* the temp is already gone */ }
    return false;
  }
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    return null;   // no git, no repo, or a path git refuses — recovery degrades, never throws
  }
}

/**
 * Every path git says changed, from `git status -z -uall`: -z because --short C-quotes unusual
 * paths, -uall because an untracked directory is one entry otherwise. A rename yields both paths.
 */
export function gitTouched(cwd) {
  const out = git(["status", "--porcelain", "-z", "-uall"], cwd);
  if (out === null) return [];
  const fields = out.split("\0").filter(f => f !== "");
  const paths = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;              // "XY path" — anything shorter is not an entry
    const xy = entry.slice(0, 2);
    paths.push(entry.slice(3));
    // R/C entries are followed by their source path as its own NUL-terminated field.
    if ((xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") && fields[i + 1] !== undefined) {
      paths.push(fields[++i]);
    }
  }
  return [...new Set(paths)];
}

/**
 * Blob sha per path by `git hash-object`, the computation the gate used for `files[p].hash`.
 * A missing path maps to null, which clears the credit exactly as a moved sha does.
 */
export function hashPaths(paths, cwd) {
  const out = new Map();
  const live = [];
  for (const p of paths) {
    if (!existsSync(join(cwd, p))) { out.set(p, null); continue; }
    // `--stdin-paths` is newline-delimited, so a path containing a newline cannot ride the batch.
    if (p.includes("\n")) {
      const one = git(["hash-object", "--", p], cwd);
      out.set(p, one ? one.trim() : null);
      continue;
    }
    live.push(p);
  }
  if (!live.length) return out;
  let res = null;
  try {
    res = execFileSync("git", ["hash-object", "--stdin-paths"], {
      cwd, encoding: "utf8", input: `${live.join("\n")}\n`, maxBuffer: 16 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    res = null;
  }
  const shas = res === null ? [] : res.trim().split("\n").filter(Boolean);
  // A short batch means git stopped early; the paths it never reached get null rather than a
  // borrowed sha from the wrong file, which would keep a credit alive on unexamined bytes.
  for (let i = 0; i < live.length; i++) out.set(live[i], shas[i] ?? null);
  return out;
}

/**
 * Append `line` to a notes tail, evicting whole lines from the front until it fits CAPS.NOTES
 * (a mid-line elision is #6528). apply.mjs and migrate.mjs hold their own copy of this loop.
 */
function appendNote(notes, line) {
  const all = [notes, line].filter(Boolean).join("\n").split("\n");
  while (all.length > 1 && Buffer.byteLength(all.join("\n"), "utf8") > CAPS.NOTES) all.shift();
  let outStr = all.join("\n");
  while (outStr.length && Buffer.byteLength(outStr, "utf8") > CAPS.NOTES) outStr = outStr.slice(1);
  return outStr;
}

/**
 * Rebuild what a cut turn observed from ground truth (TDD §4.4): `touched` from git, and every
 * credited path RE-HASHED with the credit cleared where the blob moved (R12). readState persists.
 */
export function recover(state, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const next = structuredClone(state);
  const touched = gitTouched(cwd);
  for (const p of touched) {
    if (p.length > CAPS.PATH) continue;                 // a path the schema cannot hold is not a fact it can carry
    const cur = next.files[p] || { touched: false, verified: false };
    next.files[p] = { ...cur, touched: true };
  }

  const credited = Object.keys(next.files).filter(p => next.files[p].verified === true);
  const shas = hashPaths(credited, cwd);
  const cleared = [];
  for (const p of credited) {
    // `hash` is a string or absent by the schema (the state was decoded by migrate() on read), and
    // `sha` is a 40-char blob sha or null, so an absent record can never accidentally compare equal.
    const sha = shas.get(p) ?? null;
    if (sha !== null && sha === next.files[p].hash) continue;
    const kept = { ...next.files[p], verified: false };
    delete kept.hash;
    next.files[p] = kept;
    cleared.push(p);
  }

  const turn = Number.isInteger(opts.turn) ? opts.turn : next.cursor.turn;
  next.notes = appendNote(
    next.notes,
    `recovered: turn ${turn} was cut; touched paths re-derived from git; ${cleared.length} stale verifications cleared`,
  );
  return { state: next, cleared, touched };
}

/**
 * Read + migrate + recover: the left edge of the §4.1 diagram. Returns { ok:true, state, path,
 * created, migrated, recovered } or { ok:false, code, at, message }.
 */
export function readState(seat, card, opts = {}) {
  const path = statePath(seat, card, opts.project);
  if (!path) {
    return { ok: false, code: ERR.SCHEMA, at: "path", message: `no safe sidecar path for seat ${JSON.stringify(seat)} card ${JSON.stringify(card)} project ${JSON.stringify(opts.project)}` };
  }
  const by = String(opts.by ?? seat ?? "");
  if (!existsSync(path)) {
    return { ok: true, state: emptyState(card, by), path, created: true, migrated: false, recovered: null };
  }

  let raw;
  try { raw = readFileSync(path, "utf8"); }
  catch (e) { return { ok: false, code: ERR.MIGRATE_FAILED, at: "read", message: `sidecar unreadable: ${e.message}` }; }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) {
    preserve(path, raw, null);
    return { ok: false, code: ERR.MIGRATE_FAILED, at: "parse", message: `sidecar is not JSON: ${e.message}` };
  }

  const m = migrate(parsed);
  if (!m.ok) {
    // The original is kept, untouched, beside itself — a half-upgraded sidecar is worse than a
    // loud one, and the read stays loud on every retry until someone looks (TDD §4.3).
    preserve(path, raw, parsed?.schema_version);
    return m;
  }

  let state = m.state;
  let recovered = null;
  const markers = opts.recover === false ? [] : turncutPaths(opts.agent ?? seat, opts.project).filter(existsSync);
  if (markers.length) {
    const r = recover(state, { cwd: opts.cwd, turn: state.cursor.turn });
    state = r.state;
    // Persist before clearing the marker (a failed write keeps the marker for the next read).
    // `rev` is NOT bumped: the repair restores what the dead turn owned, so the caller's expectedRev
    // must still match the disk when it commits.
    const persisted = writeAtomic(path, `${JSON.stringify(state)}\n`);
    if (persisted) for (const f of markers) { try { rmSync(f, { force: true }); } catch { /* another writer got it */ } }
    recovered = { turn: state.cursor.turn, cleared: r.cleared, persisted };
  }
  return { ok: true, state, path, created: false, migrated: m.migrated, recovered };
}

/** Keep a copy of a sidecar we refused to upgrade, at `<name>.v<n>.json`. First copy wins. */
function preserve(path, raw, version) {
  const n = Number.isInteger(version) ? version : "unknown";
  const aside = `${path.slice(0, -".json".length)}.v${n}.json`;
  if (existsSync(aside)) return;
  writeAtomic(aside, raw);
}

/**
 * Compare-and-swap write (TDD §4.4): if the on-disk rev moved since the read, return STALE honestly;
 * the driver re-reads and re-runs applyTurn (safe because ops are id-addressed).
 */
export function commit(state, expectedRev, opts = {}) {
  const path = statePath(opts.seat, opts.card ?? state?.card, opts.project);
  if (!path) {
    return { ok: false, code: ERR.SCHEMA, at: "path", message: `no safe sidecar path for seat ${JSON.stringify(opts.seat)} project ${JSON.stringify(opts.project)}` };
  }
  const why = stateError(state);
  if (why) {
    // A store that writes an invalid state has thrown away the only guarantee a reader has.
    return { ok: false, code: ERR.SCHEMA, at: "state", message: `refusing to commit an invalid state: ${why}` };
  }

  const onDisk = diskRev(path);
  if (onDisk !== expectedRev) {
    return {
      ok: false, code: STALE, at: "rev", rev: onDisk,
      message: `state moved under this turn: expected rev ${expectedRev}, on disk ${onDisk}. Re-read and re-run applyTurn on the fresh state.`,
    };
  }

  if (!writeAtomic(path, `${JSON.stringify(state)}\n`)) {
    return { ok: false, code: ERR.SCHEMA, at: "write", message: `could not write ${path}` };
  }
  if (Array.isArray(opts.ops) && opts.ops.length) {
    appendJournal(opts.seat, opts.card ?? state.card, opts.project, {
      ts: Date.now(), rev: state.rev, turn: state.cursor.turn, by: state.cursor.by, ops: opts.ops,
    });
  }
  return { ok: true, rev: state.rev, path };
}

/** The rev currently on disk. A sidecar that is missing, unreadable or unparseable reads as 0 —
 *  the same rev an empty state carries, so a first write matches and a later one does not. */
function diskRev(path) {
  try {
    const cur = JSON.parse(readFileSync(path, "utf8"));
    return Number.isInteger(cur?.rev) ? cur.rev : 0;
  } catch {
    return 0;
  }
}

/**
 * Append one accepted patch to the journal ring. FORENSICS AND TEST REPLAY ONLY — nothing in
 * recovery reads this file, and §4.4 says so out loud so a reviewer can check the claim.
 */
export function appendJournal(seat, card, project, entry) {
  const path = opsPath(seat, card, project);
  if (!path) return false;
  let lines = [];
  try { lines = readFileSync(path, "utf8").split("\n").filter(Boolean); } catch { lines = []; }
  lines.push(JSON.stringify(entry));
  if (lines.length > JOURNAL_LINES) lines = lines.slice(lines.length - JOURNAL_LINES);
  return writeAtomic(path, `${lines.join("\n")}\n`);
}

/** Read the journal back. For a forensics tool or a replay test, never for recovery. */
export function readJournal(seat, card, project) {
  const path = opsPath(seat, card, project);
  if (!path) return [];
  let raw;
  try { raw = readFileSync(path, "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn tail is a forensics artefact, not a fault */ }
  }
  return out;
}

/**
 * Sidecars whose card is terminal (the caller's predicate) and unchanged for GC_AGE_MS. Removes only
 * when `apply` is set; the default answer is a list.
 */
export function gcSidecars(opts = {}) {
  const dir = stateDir(opts.project);
  const isTerminal = opts.isTerminal || (() => false);
  const now = Number.isInteger(opts.now) ? opts.now : Date.now();
  const maxAgeMs = Number.isInteger(opts.maxAgeMs) ? opts.maxAgeMs : GC_AGE_MS;
  const candidates = [], removed = [];
  if (!dir || !existsSync(dir)) return { candidates, removed };

  for (const name of readdirSync(dir)) {
    const m = /^(.+)--(\d+)\.json$/.exec(name);
    if (!m) continue;                                   // .ops.jsonl and preserved .v<n>.json are not sidecars
    const path = join(dir, name);
    let ageMs;
    try { ageMs = now - statSync(path).mtimeMs; } catch { continue; }
    if (ageMs < maxAgeMs) continue;
    const card = Number(m[2]);
    if (!isTerminal(card)) continue;
    candidates.push({ path, seat: m[1], card, ageMs });
  }
  if (!opts.apply) return { candidates, removed };

  for (const c of candidates) {
    const stem = c.path.slice(0, -".json".length);
    for (const f of [c.path, `${stem}.ops.jsonl`, ...preservedFor(dir, stem)]) {
      try { if (existsSync(f)) { rmSync(f, { force: true }); removed.push(f); } } catch { /* leave it for the next sweep */ }
    }
  }
  return { candidates, removed };
}

/** The `.v<n>.json` copies preserved beside one sidecar, so gc takes the whole set or none of it. */
function preservedFor(dir, stem) {
  const prefix = `${stem.slice(dir.length + 1)}.v`;
  try {
    return readdirSync(dir).filter(n => n.startsWith(prefix) && n.endsWith(".json")).map(n => join(dir, n));
  } catch {
    return [];
  }
}

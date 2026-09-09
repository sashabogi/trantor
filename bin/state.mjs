#!/usr/bin/env node
// trantor state — read the seat's working memory with your own eyes (TDD §4.1, P2).
//
//   trantor state show <seat> <card> [--json]        render one sidecar (raw JSON with --json)
//   trantor state validate [<seat> <card>] [--json]  read + migrate + schema-check; non-zero on failure
//   trantor state reset <seat> <card> --force        delete one sidecar (state is derived)
//   trantor state gc [--apply] [--older 14d]         drop sidecars for terminal cards past the age
//
// This is the repair-and-inspect surface: when a seat behaves as though it believes something the
// world does not, this is where you look. `show` and `validate` therefore do NOT write — they pass
// `recover: false`, because a turncut repair firing under an inspection command would edit the very
// bytes you came to read.
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { migrate } from "../lib/state/migrate.mjs";
import { stateError } from "../lib/state/schema.mjs";
import { GC_AGE_MS, gcSidecars, opsPath, readJournal, readState, stateDir, statePath } from "../lib/state/store.mjs";
import { resolveProject } from "../lib/project.mjs";
import { relayUrl, signedGet } from "../hooks/lib/api.mjs";

// A card is finished with its working memory only once the board says the work is over. `failed`
// is NOT terminal — the orchestrator bounces a failed card back to doing, and the state it kept is
// exactly what the next attempt wants. `blocked` is waiting, not over.
const TERMINAL = ["done", "stale"];

/** The §3 VerifyFact fields, in the order a person reads them. Anything else prints after. */
const VERIFY_ORDER = ["cmd", "exit", "tested", "built", "observed"];

const argv = process.argv.slice(2);
const has = (...f) => f.some(x => argv.includes(x));
const val = (...f) => { for (const x of f) { const i = argv.indexOf(x); if (i >= 0) return argv[i + 1]; } return undefined; };
const positional = (() => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("-")) { if (["--project", "--older"].includes(argv[i])) i++; continue; }
    out.push(argv[i]);
  }
  return out;
})();

const asJson = has("--json");
const project = val("--project") || resolveProject(process.cwd());
const [sub, ...rest] = positional;

const die = (msg, code = 1) => { console.error(msg); process.exit(code); };
const emit = (obj, exit = 0) => { process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`); process.exit(exit); };

/** `<seat> <card>` off the positional tail, checked before anything touches the disk. */
function seatCard(args) {
  const [seat, rawCard] = args;
  if (!seat || rawCard === undefined) die(`usage: trantor state ${sub} <seat> <card>   e.g. trantor state ${sub} claude:trantor 6911`, 2);
  const card = Number(rawCard);
  if (!Number.isInteger(card) || card < 0) die(`card must be a non-negative integer, got ${JSON.stringify(rawCard)}`, 2);
  const path = statePath(seat, card, project);
  if (!path) die(`no safe sidecar path for seat ${JSON.stringify(seat)} card ${card} project ${JSON.stringify(project)}`, 2);
  return { seat, card, path };
}

function parseAge(s, def) {
  if (s === undefined) return def;
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*(m|h|d)?$/i);
  if (!m) die(`--older wants a duration like 14d, 36h or 90m — got ${JSON.stringify(s)}`, 2);
  return Math.round(Number(m[1]) * ({ m: 60000, h: 3600000, d: 86400000 }[(m[2] || "d").toLowerCase()]));
}

const fmtAge = (ms) => {
  const d = Math.floor(ms / 86400000);
  if (d >= 1) return `${d}d`;
  const h = Math.floor(ms / 3600000);
  return h >= 1 ? `${h}h` : `${Math.max(0, Math.round(ms / 60000))}m`;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** Width for a left column, capped so one long path cannot shove every other line off screen. */
const col = (values) => Math.min(48, values.reduce((w, v) => Math.max(w, String(v).length), 0));

// ── show ──────────────────────────────────────────────────────────────────────────────────────
function render(state, meta) {
  const L = [];
  const cur = state.cursor || {};
  L.push(`${meta.seat} · card ${state.card} · ${project}`);
  L.push(`  ${meta.path}`);
  const age = cur.ts ? ` · ${fmtAge(Date.now() - cur.ts)} ago` : "";
  L.push(`  rev ${state.rev} · turn ${cur.turn ?? 0} · by ${cur.by || "—"}${age}${meta.migrated ? " · MIGRATED on read" : ""}`);

  L.push("");
  L.push(`task  ${state.task || "—"}`);

  for (const list of ["done", "in_flight", "next", "blockers"]) {
    const items = state[list] || [];
    L.push("");
    L.push(`${list} (${items.length})${list === "done" && state.done_count !== items.length ? `  · done_count ${state.done_count}` : ""}`);
    if (!items.length) { L.push("  —"); continue; }
    const w = col(items.map(i => i.id));
    for (const it of items) {
      const paths = it.paths?.length ? `  @${it.paths.join(",")}` : "";
      L.push(`  ${it.id.padEnd(w)}  ${it.text}${paths}`);
    }
  }

  const files = Object.entries(state.files || {});
  const verified = files.filter(([, f]) => f.verified).length;
  L.push("");
  L.push(`files (${files.length}${files.length ? ` · ${verified} verified` : ""})${state.files_count !== files.length ? `  · files_count ${state.files_count}` : ""}`);
  if (!files.length) L.push("  —");
  // The verified column is the one a debugging session is usually here for: a credit that outlived
  // the bytes it was granted on (R12) reads as a green beside a file you know you just edited.
  const fw = col(files.map(([p]) => p));
  for (const [p, f] of files) {
    const marks = [f.verified ? "verified" : "", f.touched ? "touched" : ""].filter(Boolean).join(" ") || "—";
    const hash = f.hash ? ` · ${String(f.hash).slice(0, 8)}` : "";
    const blast = Number.isInteger(f.blast_radius) ? ` · blast ${f.blast_radius}` : "";
    L.push(`  ${f.verified ? "✓" : "·"} ${p.padEnd(fw)}  ${marks}${hash}${blast}`);
  }

  const v = state.verify || {};
  const vkeys = Object.keys(v);
  L.push("");
  L.push("verify");
  if (!vkeys.length) L.push("  — (no gate has run at this rev)");
  // The command first, because it is the line that answers "verified by WHAT" — and it prints bare
  // while everything else goes through JSON, so a `false` reads as false rather than as a blank.
  else for (const k of [...VERIFY_ORDER.filter(k => k in v), ...vkeys.filter(k => !VERIFY_ORDER.includes(k))]) {
    L.push(`  ${k}: ${k === "cmd" ? String(v.cmd) : JSON.stringify(v[k])}`);
  }

  L.push("");
  L.push(`notes (${Buffer.byteLength(state.notes || "", "utf8")} B)`);
  L.push(state.notes ? state.notes.split("\n").map(l => `  ${l}`).join("\n") : "  —");

  const ext = Object.entries(state.ext || {});
  if (ext.length) {
    L.push("");
    L.push("ext");
    for (const [k, x] of ext) L.push(`  ${k}: ${JSON.stringify(x)}`);
  }

  if (meta.ops !== null) {
    L.push("");
    L.push(`ops journal: ${meta.ops} ${meta.ops === 1 ? "entry" : "entries"} · ${opsPath(meta.seat, state.card, project)}`);
  }
  return L.join("\n");
}

function cmdShow() {
  const { seat, card, path } = seatCard(rest);
  if (!existsSync(path)) {
    if (asJson) emit({ ok: false, code: "NO_SIDECAR", seat, card, project, path }, 1);
    die(`no sidecar yet for ${seat} on card ${card}\n  looked at ${path}\n  state is derived — this seat has not written a turn on this card.`);
  }
  if (asJson) {
    // Raw, on purpose: --json is what you pipe into jq when the rendered view has already told you
    // something is wrong. It is the bytes on disk, not this command's reading of them.
    process.stdout.write(readFileSync(path, "utf8").trimEnd() + "\n");
    process.exit(0);
  }
  const r = readState(seat, card, { project, recover: false });
  if (!r.ok) die(`${r.code} at ${r.at}: ${r.message}\n  the file is still there — ${path}\n  raw bytes: trantor state show ${seat} ${card} --json`);
  let ops = null;
  try { ops = readJournal(seat, card, project).length; } catch { ops = null; }
  console.log(render(r.state, { seat, path, migrated: r.migrated, ops }));
}

// ── validate ──────────────────────────────────────────────────────────────────────────────────
/** One sidecar, all the way through the read path: parse → migrate → schema. */
function checkOne(path) {
  const name = basename(path);
  const m = /^(.+)--(\d+)\.json$/.exec(name);
  const seat = m ? m[1] : name;
  const card = m ? Number(m[2]) : null;
  let raw;
  try { raw = readFileSync(path, "utf8"); }
  catch (e) { return { path, seat, card, ok: false, code: "MIGRATE_FAILED", at: "read", message: `sidecar unreadable: ${e.message}` }; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { return { path, seat, card, ok: false, code: "MIGRATE_FAILED", at: "parse", message: `sidecar is not JSON: ${e.message}` }; }
  const r = migrate(parsed);
  if (!r.ok) return { path, seat, card, ok: false, code: r.code, at: r.at, message: r.message };
  // migrate() already schema-checks what it returns; re-asserting here is what makes this command
  // a check rather than a restatement of migrate's own opinion.
  const why = stateError(r.state);
  if (why) return { path, seat, card, ok: false, code: "SCHEMA", at: "state", message: why };
  return { path, seat, card, ok: true, migrated: r.migrated, from: parsed.schema_version, rev: r.state.rev };
}

function cmdValidate() {
  let paths;
  if (rest.length) {
    const { path } = seatCard(rest);
    if (!existsSync(path)) {
      const miss = { ok: false, code: "NO_SIDECAR", at: "path", message: `no sidecar at ${path}`, path };
      if (asJson) emit({ project, checked: 0, failed: 1, results: [miss] }, 1);
      die(`no sidecar at ${path}`);
    }
    paths = [path];
  } else {
    const dir = stateDir(project);
    paths = (dir && existsSync(dir) ? readdirSync(dir) : [])
      .filter(n => /^(.+)--(\d+)\.json$/.test(n))
      .map(n => join(dir, n))
      .sort();
  }

  const results = paths.map(checkOne);
  const bad = results.filter(r => !r.ok);
  if (asJson) emit({ project, checked: results.length, failed: bad.length, results }, bad.length ? 1 : 0);

  if (!results.length) { console.log(`${project}: no sidecars under ${stateDir(project)} — nothing to validate.`); process.exit(0); }
  for (const r of results) {
    if (r.ok) console.log(`  ok    ${r.seat} · card ${r.card}  rev ${r.rev}${r.migrated ? `  (migrated from v${r.from})` : ""}`);
    else console.log(`  FAIL  ${r.seat} · card ${r.card}\n          ${r.code} at ${r.at}: ${r.message}\n          ${r.path}`);
  }
  console.log(`\n${project}: ${plural(results.length, "sidecar")}, ${bad.length} failed`);
  process.exit(bad.length ? 1 : 0);
}

// ── reset ─────────────────────────────────────────────────────────────────────────────────────
function confirm(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(question, a => { rl.close(); res(/^y(es)?$/i.test(a.trim())); }));
}

async function cmdReset() {
  const { seat, card, path } = seatCard(rest);
  const ops = opsPath(seat, card, project);
  const victims = [path, ops].filter(p => p && existsSync(p));
  if (!victims.length) {
    if (asJson) emit({ ok: true, removed: [], note: "nothing to reset" });
    console.log(`nothing to reset — no sidecar for ${seat} on card ${card}.`);
    process.exit(0);
  }
  if (!has("--force", "-f")) {
    // A prompt nobody can answer is not a safeguard, so a non-TTY without --force refuses rather
    // than hanging or (worse) defaulting to yes.
    const yes = await confirm(`delete ${plural(victims.length, "file")} of working memory for ${seat} on card ${card}? state is derived and safe to lose [y/N] `);
    if (!yes) die(process.stdin.isTTY ? "cancelled." : "refusing to reset without a TTY to confirm at — pass --force if you mean it.", 2);
  }
  const removed = [];
  for (const f of victims) { try { rmSync(f, { force: true }); removed.push(f); } catch (e) { die(`could not remove ${f}: ${e.message}`); } }
  if (asJson) emit({ ok: true, seat, card, project, removed });
  console.log(`reset ${seat} · card ${card} — removed ${plural(removed.length, "file")}:`);
  for (const f of removed) console.log(`  ${f}`);
}

// ── gc ────────────────────────────────────────────────────────────────────────────────────────
async function cmdGc() {
  const maxAgeMs = parseAge(val("--older"), GC_AGE_MS);
  const apply = has("--apply", "--yes", "-y");

  // The board owns the word "terminal", so gc asks it. An unreachable hub means every card's
  // status is unknown, and unknown must never read as terminal — so gc refuses rather than
  // deleting on a guess. (R9 is sidecar sprawl; deleting live working memory is worse.)
  const r = await signedGet(`/tasks?project=${encodeURIComponent(project)}`, { timeoutMs: 6000 }).catch(e => ({ ok: false, status: 0, error: e.message }));
  if (!r.ok) die(`could not reach the hub at ${relayUrl(project)} (status ${r.status ?? 0}) — gc needs card statuses and will not guess which cards are finished.`);
  const tasks = Array.isArray(r.json) ? r.json : (r.json?.tasks || r.json?.cards || []);
  const terminal = new Set(tasks.filter(t => TERMINAL.includes(t.status)).map(t => Number(t.id)));

  const { candidates, removed } = gcSidecars({
    project, maxAgeMs, apply,
    isTerminal: (card) => terminal.has(card),
  });

  if (asJson) emit({ project, maxAgeMs, applied: apply, candidates, removed });
  const window = fmtAge(maxAgeMs);
  if (!candidates.length) {
    console.log(`${project}: nothing to collect — no sidecar belongs to a ${TERMINAL.join("/")} card older than ${window}.`);
    process.exit(0);
  }
  console.log(`${project}: ${plural(candidates.length, "sidecar")} for finished cards, untouched for ${window}+`);
  for (const c of candidates) console.log(`  ${c.seat} · card ${c.card}  ${fmtAge(c.ageMs)} old  ${c.path}`);
  if (!apply) { console.log(`\npreview only — rerun with --apply to delete them. state is derived and safe to lose.`); process.exit(0); }
  console.log(`\nremoved ${plural(removed.length, "file")} (sidecars, journals and preserved copies).`);
}

// ── dispatch ──────────────────────────────────────────────────────────────────────────────────
switch (sub) {
  case "show": cmdShow(); break;
  case "validate": cmdValidate(); break;
  case "reset": await cmdReset(); break;
  case "gc": await cmdGc(); break;
  default:
    console.log(`trantor state — inspect and repair a seat's working memory (project: ${project})

  trantor state show <seat> <card>       render the sidecar readably  [--json = the raw bytes]
  trantor state validate [<seat> <card>] read + migrate + schema-check; every sidecar when no card is named
  trantor state reset <seat> <card>      delete one seat-card's working memory  [--force to skip the prompt]
  trantor state gc [--apply]             drop sidecars for ${TERMINAL.join("/")} cards older than ${fmtAge(GC_AGE_MS)}  [--older 30d]

  --project <name>   act on another project's sidecars (default: the cwd's project)

State is DERIVED — losing it costs a re-read, never the work. Sidecars live under
${stateDir(project)}`);
    process.exit(sub ? 2 : 0);
}

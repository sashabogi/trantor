// Trantor State P5.5: the gate (TDD §4.8). runGate(spec, opts) computes and returns; it NEVER
// touches state. Invariants (docs/CONTRACT-state.md): the memo keys on tree CONTENT, never
// porcelain; the scoped suite resolves BEFORE scripts.test (seats never run the full suite);
// `verified` means a gate covering that path passed (R11).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CAPS } from "./schema.mjs";

const DEFAULT_MAX_MS = 300_000;
/** GNU timeout's convention: a timebox kill is a RED gate, never a missing one. */
export const TIMED_OUT_EXIT = 124;

const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return {
    status: r.status,
    timedOut: r.error?.code === "ABORT_ERR" || (r.error?.code === "ETIMEDOUT"),
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
};

/** Last `CAPS.OBS_TOKENS` bytes of combined output — the seat's next observation starts here. */
const tailOf = (...outs) => {
  const t = outs.filter(Boolean).join("\n").trim();
  return t.length > CAPS.OBS_TOKENS ? t.slice(-CAPS.OBS_TOKENS) : t;
};

/**
 * Command resolution (§4.8), first match wins: TRANTOR_STATE_GATE → the scoped `--only <subsystem>`
 * form (paths under one subsystem with a sibling test dir) → scripts.test → none. Build likewise.
 */
export function resolveGateCommand(spec = {}, { cwd = process.cwd(), env = process.env } = {}) {
  if (env.TRANTOR_STATE_GATE) {
    return { kind: "explicit", cmd: env.TRANTOR_STATE_GATE };
  }
  const subsystem = scopedSubsystem(spec.paths || [], { cwd });
  if (subsystem) {
    return { kind: "scoped", subsystem, cmd: `node test/run.mjs --only ${subsystem}` };
  }
  const pkg = readPkg(cwd);
  if (pkg?.scripts?.test) return { kind: "scripts.test", cmd: `npm test` };
  return { kind: "none", cmd: null };
}

export function resolveBuildCommand({ cwd = process.cwd(), env = process.env } = {}) {
  if (env.TRANTOR_STATE_BUILD) return { kind: "explicit", cmd: env.TRANTOR_STATE_BUILD };
  const pkg = readPkg(cwd);
  if (pkg?.scripts?.typecheck) return { kind: "scripts.typecheck", cmd: "npm run typecheck" };
  if (pkg?.scripts?.build) return { kind: "scripts.build", cmd: "npm run build" };
  return { kind: "none", cmd: null };
}

function readPkg(cwd) {
  try {
    return JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Idempotently add `entry` to the repo's local excludes (never a tracked file, so it cannot
 *  change the tree or a diff — it only changes what `add -A` picks up). */
function ensureIgnored(cwd, entry) {
  const p = sh("git", ["rev-parse", "--git-path", "info/exclude"], { cwd });
  const f = p.status === 0 && p.stdout.trim() ? resolve(cwd, p.stdout.trim()) : null;
  if (!f) return;
  let cur = "";
  try { cur = readFileSync(f, "utf8"); } catch { /* first write */ }
  if (!cur.split("\n").includes(entry)) {
    try {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, `${cur}${cur.endsWith("\n") || !cur ? "" : "\n"}${entry}\n`);
    } catch { /* read-only git dir: the add below may then fold the scratch in — the memo
                 misses every time, which is the safe direction (re-run, never stale green). */ }
  }
}

function hasSuites(cwd, sub) {
  const dir = join(cwd, "test", sub);
  if (!existsSync(dir)) return false;
  try {
    return existsSync(join(dir, "test.mjs")) ||
      readdirSync(dir).some(f => /^test-[\w.-]+\.(mjs|sh)$/.test(f));
  } catch {
    return false;
  }
}

/** The one subsystem all paths share, or null. `lib/state/gate.mjs` → "state" when test/state/ has suites. */
function scopedSubsystem(paths, opts) {
  if (!paths.length) return null;
  let shared = null;
  for (const p of paths) {
    const sub = subsystemOf(p, opts);
    if (!sub) return null; // a path no suite dir covers → scope cannot place the work
    if (shared === null) shared = sub;
    else if (shared !== sub) return null; // spans two subsystems → not one scoped suite
  }
  return shared;
}

/** Shallowest directory segment of `p` that has a sibling suite dir — the subsystem a path
 *  belongs to, or null. ONE rule for both resolution and credits, so the lane that ran and the
 *  lane that gets credited can never drift apart. */
function subsystemOf(p, { cwd }) {
  const segs = p.split("/");
  return segs.slice(0, -1).find(s => s && s !== ".." && hasSuites(cwd, s)) || null;
}

/**
 * Tree CONTENT hash: HEAD sha + the worktree tree sha via a SCRATCH index (the real index is never
 * touched; `add -A` folds in untracked files). Scratch dir: <cwd>/.agent-bus-out/, else tmp.
 */
export function contentHash(cwd) {
  const scratchDir = join(cwd, ".agent-bus-out");
  let dir = scratchDir;
  let outside = false;
  try {
    mkdirSync(scratchDir, { recursive: true });
  } catch {
    dir = mkdtempSync(join(tmpdir(), "trantor-gate-"));
    outside = true;
  }
  // Make the scratch dir gitignored locally (.git/info/exclude via --git-path, worktree-safe), or
  // `add -A` folds the index file's own bytes into the tree and the memo never hits. Never pass
  // the dir as a pathspec: an explicit `:(exclude)` on an ignored path makes git refuse the add.
  if (!outside) {
    ensureIgnored(cwd, ".agent-bus-out/");
  }
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, "gate-index") };
  const add = sh("git", ["add", "-A"], { cwd, env });
  if (add.status !== 0) return null;
  const tree = sh("git", ["write-tree"], { cwd, env });
  if (tree.status !== 0) return null;
  const head = sh("git", ["rev-parse", "HEAD"], { cwd, env });
  return `${head.stdout.trim()}+${tree.stdout.trim()}`;
}

/** Paths the worktree has actually changed vs HEAD — the TOUCHED set (tier 1's fact).
 *  `-uall` so an untracked DIRECTORY expands to the files inside it (`?? bin/` would hide the
 *  path a credit must name). Porcelain is fine HERE: touched is about which paths differ, not
 *  about evidence. The memo hash above is where content, not status letters, is the only key. */
export function touchedPaths(cwd) {
  // -z is load-bearing: without it git C-quotes non-ASCII paths and the credit a seat names never
  // matches its file (fails closed, so only a deliberate test catches it).
  const out = sh("git", ["status", "--porcelain", "-z", "-uall"], { cwd });
  if (out.status !== 0) return [];
  const fields = out.stdout.split("\0").filter(Boolean);
  const paths = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // A rename or copy emits its ORIGINAL path as the next NUL-terminated field. Consume it so it
    // is not mistaken for a status entry, and count it too: the old path changed as surely as the
    // new one did.
    if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") {
      const src = fields[++i];
      if (src) paths.push(src);
    }
  }
  return paths;
}

/** In scope for a `scoped:test/<sub>` credit = the path maps to the same subsystem the scoped
 *  suite covers, by the one rule above. Paths outside stay verified:false (R11). */
const inScope = (p, sub, opts) => (sub ? subsystemOf(p, opts) === sub : true);

/**
 * Run the gate: spec = NEEDS_GATE's { items, paths }; opts = cwd, env, memo, maxMs (timeout is RED).
 * Returns { verify, files, coverage, cmd, exit, ms, tail, memo, memoHit }. docs/CONTRACT-state.md.
 */
export function runGate(spec = {}, opts = {}) {
  const cwd = resolve(opts.cwd || process.cwd());
  const env = { ...process.env, ...opts.env };
  const maxMs = opts.maxMs ?? (Number(env.GATE_MAX_MS) || DEFAULT_MAX_MS);
  const t0 = Date.now();

  // ---- resolve first: the command is part of the memo key, not just its output ----
  const build = resolveBuildCommand({ cwd, env });
  const gateCmd = resolveGateCommand(spec, { cwd, env });

  // ---- the memo is keyed on CONTENT, and checked before anything spawns ----
  // Same HEAD + same tree bytes + SAME GATE COMMAND as the green run. The command is in the key
  // because a different TRANTOR_STATE_GATE on unchanged bytes is a different gate — reusing the
  // old green there would be exactly the stale-green-as-evidence bug this file exists to prevent.
  const hash = contentHash(cwd);
  if (hash && opts.memo && opts.memo.hash === hash &&
      opts.memo.cmd === gateCmd.cmd && opts.memo.verify?.tested === true) {
    // Same HEAD + same tree bytes as the green run: reuse, no spawn, no slop re-run. The touched
    // set is identical too (same diff), so the recorded files map is still the truth.
    return {
      verify: { ...opts.memo.verify },
      files: JSON.parse(JSON.stringify(opts.memo.files || {})),
      coverage: opts.memo.coverage,
      cmd: opts.memo.cmd,
      exit: opts.memo.exit ?? 0,
      ms: Date.now() - t0,
      tail: opts.memo.tail ?? "",
      memo: opts.memo,
      memoHit: true,
    };
  }

  // ---- touched set, before running anything (git is ground truth, not testimony) ----
  const touched = touchedPaths(cwd);

  // ---- run: build (if any) → gate command → slop-gate (always, when present) ----
  let exit = 0;
  let tail = "";
  const verify = { tested: false };
  let coverage = "project";
  const runCmdLine = (cmdline) => {
    // A resolved command is a shell line from a trusted source (repo scripts / operator env),
    // never seat input — spec.paths only SELECTS among them.
    const r = sh("sh", ["-c", cmdline], { cwd, env, timeout: maxMs, killSignal: "SIGTERM" });
    return r;
  };

  if (build.cmd) {
    const b = runCmdLine(build.cmd);
    verify.built = b.status === 0 && !b.timedOut;
    if (b.timedOut) { exit = exit || TIMED_OUT_EXIT; tail += `\n[build] TIMED OUT after ${maxMs}ms\n` + b.stdout + b.stderr; }
    else if (b.status !== 0) { exit = exit || (b.status ?? 1); tail += `\n[build exit ${b.status}]\n` + b.stdout + b.stderr; }
  }

  if (gateCmd.kind === "none") {
    exit = exit || 1;
    tail += "\n[gate] no test command resolved (TRANTOR_STATE_GATE, scoped form, scripts.test all missed)\n";
    verify.cmd = null;
    verify.exit = exit;
  } else {
    verify.cmd = gateCmd.cmd;
    coverage = gateCmd.kind === "scoped" ? `scoped:test/${gateCmd.subsystem}` : "project";
    const g = runCmdLine(gateCmd.cmd);
    if (g.timedOut) {
      verify.exit = TIMED_OUT_EXIT;
      exit = exit || TIMED_OUT_EXIT; // a timeout is a RED gate, not a missing one
      tail += `\n[gate] TIMED OUT after ${maxMs}ms: ${gateCmd.cmd}\n` + g.stdout + g.stderr;
    } else {
      verify.exit = g.status ?? 1;
      exit = exit || (g.status ?? 1);
      tail += `\n[gate exit ${g.status ?? 1}] ${gateCmd.cmd}\n` + g.stdout + g.stderr;
    }
  }

  // ---- slop-gate, always, when this repo has one: no card reaches done with it red ----
  const slopPath = join(cwd, "bin", "slop-gate.mjs");
  if (existsSync(slopPath)) {
    const s = sh(process.execPath, [slopPath], { cwd, env, timeout: maxMs });
    if (s.timedOut) {
      exit = exit || TIMED_OUT_EXIT;
      tail += `\n[slop-gate] TIMED OUT after ${maxMs}ms\n` + s.stdout + s.stderr;
    } else if (s.status !== 0) {
      exit = exit || (s.status ?? 1); // a green suite with red slop is still a RED gate
      tail += `\n[slop-gate exit ${s.status}]\n` + s.stdout + s.stderr;
    }
  }

  // The design's literal rule — computed AFTER everything that can redden the gate (suite, build,
  // slop). In the none-case above exit is forced non-zero, so exit===0 already implies a test ran.
  verify.tested = exit === 0;

  // ---- credits (R11): only paths a gate of this coverage actually passed ----
  const scopeSub = coverage === "project" ? null : coverage.slice("scoped:test/".length);
  const files = {};
  if (verify.tested && exit === 0) {
    for (const p of touched) {
      if (!inScope(p, scopeSub, { cwd })) { files[p] = { touched: true, verified: false }; continue; }
      const h = sh("git", ["hash-object", p], { cwd });
      files[p] = h.status === 0
        ? { touched: true, verified: true, hash: h.stdout.trim() }
        : { touched: true, verified: false };
    }
  } else {
    for (const p of touched) files[p] = { touched: true, verified: false }; // red credits nothing
  }

  const ms = Date.now() - t0;
  const memo = {
    hash,
    verify: { ...verify },
    files: { ...files },
    coverage,
    cmd: verify.cmd,
    exit,
    ms,
    tail: tailOf(tail),
    ts: Date.now(),
  };
  return {
    verify: memo.verify,
    files: memo.files,
    coverage,
    cmd: verify.cmd,
    exit,
    ms,
    tail: memo.tail,
    memo,
    memoHit: false,
  };
}

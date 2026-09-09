// Trantor State P5.5 — the gate (TDD §4.8).
//
// runGate(spec, opts) is the lazy half of the evidence pipeline: the driver calls it once at the
// `move → done` boundary to cure NEEDS_GATE, and the shape it returns feeds ctx.gate_attempted
// and ctx.files on the retry. It NEVER touches state — it computes and returns; apply.mjs stage 5
// lands the memo through the single apply point.
//
//   runGate({ items, paths }, { cwd }) ->
//     { verify, files, coverage, cmd, exit, ms, tail, memo, memoHit }
//
// The three invariants this file exists to hold:
//   1. The memo keys on tree CONTENT (scratch-index `git write-tree`), never on
//      `git status --porcelain` — porcelain records that a path is modified, never what is in
//      it, so a re-edit of an ALREADY-modified file is byte-identical to porcelain and a stale
//      green would be reused as evidence for a done-move (the bust test in test-gate.mjs).
//   2. Scoped resolves BEFORE scripts.test. scripts.test here is the full suite; a seat running
//      the whole thing collides with sibling seats on fixed ports. Three reviewers hit this.
//   3. `verified` means "a gate covering this path passed" (R11): on scoped coverage, touched
//      paths OUTSIDE the scope come back verified:false — a scoped suite is not evidence about
//      files it never loaded.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
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
 * Command resolution (§4.8), first match wins. Exported for direct tests — resolution is pure.
 *
 * TRANTOR_STATE_GATE (explicit, per project)
 *   → the SCOPED form `node test/run.mjs --only <subsystem>`, when every path in spec.paths sits
 *     under one subsystem that has a sibling suite dir (lib/state/* ↔ test/state/) — BEFORE
 *     scripts.test, deliberately: scripts.test is the full suite and seats must never run it
 *   → package.json scripts.test
 *   → none.
 *
 * A subsystem for a path is any directory segment `<name>` of the path for which
 * `<cwd>/test/<name>/` exists and contains suites. Build command resolves the same way:
 * TRANTOR_STATE_BUILD → scripts.typecheck → scripts.build → none.
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
function scopedSubsystem(paths, { cwd }) {
  if (!paths.length) return null;
  let shared = null;
  for (const p of paths) {
    const segs = p.split("/");
    const subs = segs.slice(0, -1).filter(s => s && s !== ".." && hasSuites(cwd, s));
    const sub = subs[0] || null; // first (shallowest) matching segment wins, matching run.mjs --only
    if (!sub) return null; // a path no suite dir covers → scope cannot place the work
    if (shared === null) shared = sub;
    else if (shared !== sub) return null; // spans two subsystems → not one scoped suite
  }
  return shared;
}

/**
 * Tree CONTENT hash: HEAD sha + the worktree's tree sha, computed against a SCRATCH index so the
 * seat's real `.git/index` is never touched. `git add -A` into the scratch index folds in
 * untracked files, so a brand-new test file busts the memo too. The scratch dir defaults to
 * `<cwd>/.agent-bus-out/` (gitignored, same filesystem) and falls back to a temp dir when that
 * is not writable.
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
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, "gate-index") };
  // `:(exclude)` keeps the scratch index itself out of the tree it is about to hash — without
  // it, `add -A` folds the index file's own (timestamp-varying) bytes in and the memo can never
  // hit. Verified against git: two scratch paths hashed two different trees before this.
  const addArgs = outside ? ["add", "-A"] : ["add", "-A", "--", ":(exclude).agent-bus-out"];
  const add = sh("git", addArgs, { cwd, env });
  if (add.status !== 0) return null;
  const tree = sh("git", ["write-tree"], { cwd, env });
  if (tree.status !== 0) return null;
  const head = sh("git", ["rev-parse", "HEAD"], { cwd, env });
  return `${head.stdout.trim()}+${tree.stdout.trim()}`;
}

/** Paths the worktree has actually changed vs HEAD — the TOUCHED set (tier 1's fact).
 *  Porcelain is fine HERE: touched is about which paths differ, not about evidence. The memo
 *  hash above is where content, not status letters, is the only honest key. */
function touchedPaths(cwd) {
  const out = sh("git", ["status", "--porcelain"], { cwd });
  if (out.status !== 0) return [];
  return out.stdout.split("\n")
    .filter(l => l.length > 3)
    .map(l => l.slice(3).replace(/^"|"$/g, ""));
}

/** Paths under `dir` (or all paths when coverage is project) — used to decide credits. */
const underScope = (p, dir) => (dir ? p === dir || p.startsWith(dir + sep) || p.startsWith(dir + "/") : true);

/**
 * Run the gate. `spec` is the `gate` field NEEDS_GATE carried (`{ items, paths }`). `opts`:
 *   cwd        — the seat worktree (default process.cwd())
 *   env        — overrides process.env (tests inject TRANTOR_STATE_GATE without leaking)
 *   memo       — the prior ext._gate record `{ hash, verify, coverage, ts, ... }`, if any
 *   maxMs      — GATE_MAX_MS, default 300000; a timeout is a RED gate (exit 124)
 *
 * Returns `{ verify, files, coverage, cmd, exit, ms, tail, memo, memoHit }`:
 *   verify  — `{ tested, cmd, exit }` (+ `built` only when a build command resolved and ran).
 *             `observed` is NEVER set here: a test runner is not an observation.
 *   files   — every touched path: credited ones `{ touched, verified:true, hash }` (blob sha,
 *             what tier 1 later expires against), everything else `{ touched, verified:false }`.
 *   memo    — the record the driver should land in ext._gate via ctx.gate.
 *   memoHit — true when the recorded GREEN result was reused with no spawn.
 *
 * A RED gate (test fails, build fails, slop-gate fails, or timeout) credits no path and carries
 * cmd/exit/tail for UNVERIFIED_DONE. This function returns no rejection codes of its own — the
 * NEEDS_GATE/UNVERIFIED_DONE split belongs to the core (ctx.gate_attempted).
 */
export function runGate(spec = {}, opts = {}) {
  const cwd = resolve(opts.cwd || process.cwd());
  const env = { ...process.env, ...opts.env };
  const maxMs = opts.maxMs ?? (Number(env.GATE_MAX_MS) || DEFAULT_MAX_MS);
  const t0 = Date.now();

  // ---- the memo is keyed on CONTENT, and checked before anything spawns ----
  const hash = contentHash(cwd);
  if (hash && opts.memo && opts.memo.hash === hash && opts.memo.verify?.tested === true) {
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

  // ---- resolve + run: build (if any) → gate command → slop-gate (always, when present) ----
  const build = resolveBuildCommand({ cwd, env });
  const gateCmd = resolveGateCommand(spec, { cwd, env });

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
  // The design's literal rule. In the none-case above exit is forced non-zero, so exit===0
  // already implies a test actually ran; `tested` is never true on a red or absent gate.
  verify.tested = exit === 0;

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

  // ---- credits (R11): only paths a gate of this coverage actually passed ----
  const scopeDir = coverage === "project" ? null : coverage.slice("scoped:test/".length);
  const files = {};
  if (verify.tested && exit === 0) {
    for (const p of touched) {
      if (!underScope(p, scopeDir)) { files[p] = { touched: true, verified: false }; continue; }
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

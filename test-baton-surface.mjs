#!/usr/bin/env node
// trantor — the baton resolves WHERE the session lives from its own env, and WHICH project from
// its registration (#6074).
//
// Witnessed 2026-09-02 on crebral-scribe (hosted pane): the handoff skill ran with the shell cwd
// in a SUBFOLDER (crebral-scribe/ios). The project name came from basename(cwd) = "ios", the pane
// lookup found no "ios" row, and the baton fell to the window leg — whose front-Terminal-window
// fallback picked a window the pane session never owned: a stray Terminal session opened, and a
// close was armed against a stranger's window while the real pane session stayed alive believing
// it had handed off. The fix, as one shared resolver (resolveHandoffSurface) + a first-checked
// pane-env branch in spawnBaton:
//   • HERDR_PANE_ID set  → the pane leg, keyed by THAT pane id; no window resolved/spawned/armed.
//   • project name       → TRANTOR_ORCH / RELAY_PROJECT / orch-sessions.txt by session id, BEFORE
//                          the cwd; a subfolder cwd never renames the project.
//   • no pane env        → today's window behavior, byte for byte.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubIdentityEnv } from "./drill-env.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };

console.log("# trantor baton surface drill (#6074)");

// The drill runs under a crew runner, which exports TRANTOR_NO_*_SPAWN for its seats — correct in
// production, fatal here: every spawnBaton branch would report "suppressed" and nothing would be
// exercised. Clear the process copies; per-call suppression is injected through the _env seam
// (which spawnBaton also honors). The bus dir is pointed at the drill's own before the lib is
// imported, so orch-sessions lookups read the drill's rows, not the operator's.
const w = mkdtempSync(join(tmpdir(), "tt-surface-"));
const BUS = join(w, ".agent-bus");
delete process.env.TRANTOR_NO_HANDOFF_SPAWN;
delete process.env.TRANTOR_NO_BATON_SPAWN;
scrubIdentityEnv();   // #6108: the runner's own badge must not answer any probe below (the deletes this replaces are named in drill-env.mjs)
delete process.env.TRANTOR_PROJECT;
process.env.AGENT_BUS_DIR = BUS;
process.env.RELAY_DATA_DIR = BUS;

const { resolveHandoffSurface, paneSurfaceEnv, orchProjectForSession, spawnBaton } = await import(join(ROOT, "hooks", "lib", "handoff.mjs"));

// ── 1. the pane predicate ────────────────────────────────────────────────────
console.log("\nThe session's own env decides the surface:");
ok("no HERDR_PANE_ID → window surface", paneSurfaceEnv({}) === "" && paneSurfaceEnv({ HERDR_PANE_ID: "  " }) === "");
ok("HERDR_PANE_ID set → pane id verbatim", paneSurfaceEnv({ HERDR_PANE_ID: "pane-9" }) === "pane-9");

// ── 2. project resolution: registration before cwd — the badge only where it is TRUE ──
console.log("\nThe project comes from the registration before the cwd — and a foreign badge never relabels it (#6218):");
const projDir = join(w, "crebral-scribe"); const subDir = join(projDir, "ios"); mkdirSync(subDir, { recursive: true });
mkdirSync(BUS, { recursive: true });
// NO git init on purpose: resolveProject falls through to basename, so "ios" is exactly what the
// cwd alone would answer — any other answer below came from the registration.
writeFileSync(join(BUS, "orch-sessions.txt"), `gamma\tsid-gamma-123\n`);
ok("TRANTOR_ORCH badge names the project when the cwd is inside it (#6074 subfolder holds)",
   resolveHandoffSurface({ projectDir: subDir, env: { TRANTOR_ORCH: "crebral-scribe" } }).project === "crebral-scribe");
ok("…and outranks RELAY_PROJECT",
   resolveHandoffSurface({ projectDir: subDir, env: { TRANTOR_ORCH: "crebral-scribe", RELAY_PROJECT: "beta" } }).project === "crebral-scribe");
{
  // #6218 — the witnessed shape: a trantor-badged shell sitting in tiny-timer. The badge is
  // FOREIGN here: rejected, the whole registration chain distrusted with it, and the record
  // goes to the cwd's project. One warning line names both. The valid calls around it stay
  // silent — a warning is a discrepancy report, not decoration.
  const foreignDir = join(w, "tiny-timer");
  const errs = [];
  const origErr = console.error; console.error = (m) => errs.push(String(m));
  let r, rWt, rOtherWt;
  try {
    r = resolveHandoffSurface({ projectDir: foreignDir, env: { TRANTOR_ORCH: "crebral-scribe", RELAY_PROJECT: "crebral-scribe" } });
    rWt = resolveHandoffSurface({ projectDir: join(BUS, "worktrees", "alpha", "seat"), env: { TRANTOR_ORCH: "alpha" } });
    rOtherWt = resolveHandoffSurface({ projectDir: join(BUS, "worktrees", "other", "seat"), env: { TRANTOR_ORCH: "alpha" } });
  } finally { console.error = origErr; }
  ok("a badged shell in a FOREIGN project dir resolves from the cwd (badge + RELAY_PROJECT distrusted)",
     r.project === "tiny-timer", JSON.stringify(r));
  ok("exactly ONE warning line names both the badge and the resolved project",
     errs[0].includes("TRANTOR_ORCH=crebral-scribe") && errs[0].includes("tiny-timer"), JSON.stringify(errs));
  ok("a valid badge inside its agent-bus worktree still wins",
     rWt.project === "alpha", JSON.stringify(rWt));
  ok("a badged shell in ANOTHER project's worktrees is foreign too — the cwd answers (and warns)",
     rOtherWt.project === "seat" && errs.length === 2 && errs[1].includes("TRANTOR_ORCH=alpha") && errs[1].includes("seat"),
     JSON.stringify({ r: rOtherWt, errs }));
}
ok("a nameless badge (\"1\") falls through to RELAY_PROJECT", resolveHandoffSurface({ projectDir: subDir, env: { TRANTOR_ORCH: "1", RELAY_PROJECT: "beta" } }).project === "beta");
ok("orch-sessions.txt answers by session id", resolveHandoffSurface({ projectDir: subDir, sessionId: "sid-gamma-123", env: {} }).project === "gamma");
ok("…and outranks the cwd", resolveHandoffSurface({ projectDir: subDir, sessionId: "sid-gamma-123", env: {} }).project !== "ios");
ok("without any registration the cwd answers (fallback intact)", resolveHandoffSurface({ projectDir: subDir, env: { RELAY_PROJECT: "" } }).project === "ios");
ok("a subfolder cwd never flips the surface", resolveHandoffSurface({ projectDir: subDir, env: { HERDR_PANE_ID: "pane-9", RELAY_PROJECT: "" } }).surface === "pane"
   && resolveHandoffSurface({ projectDir: subDir, env: { RELAY_PROJECT: "" } }).surface === "window");
ok("orchProjectForSession misses cleanly", orchProjectForSession("nobody") === "" && orchProjectForSession("") === "");

// ── 3. spawnBaton: the pane-env branch is checked FIRST ─────────────────────
console.log("\nspawnBaton: pane env means the pane leg, keyed by that pane id:");
{
  const calls = [];
  const boom = (n) => () => { throw new Error(`${n} must never run for a pane session`); };
  const r = spawnBaton({
    projectDir: subDir, handoffFile: "/x/h.json",
    _env: { HERDR_PANE_ID: "pane-9" },
    _hasPane: boom("_hasPane"),              // even a matching row must not matter — env wins
    _resolveWindow: boom("_resolveWindow"), _spawnFresh: boom("_spawnFresh"), _armClose: boom("_armClose"),
    _spawnPane: (...a) => { calls.push(a); return true; },
  });
  ok("the pane leg ran", r.pane === true && r.spawned === true, JSON.stringify(r));
  ok("keyed by the ENV pane id", calls.length === 1 && calls[0][2] === "pane-9", JSON.stringify(calls));
  ok("no window resolved, spawned, or armed", r.armed === false && r.windowId === "", JSON.stringify(r));
}
{
  let paneArgs = null;
  const r = spawnBaton({
    projectDir: subDir, handoffFile: "/x/h.json",
    _env: { TRANTOR_NO_BATON_SPAWN: "1", HERDR_PANE_ID: "pane-9" },
    _spawnPane: (...a) => { paneArgs = a; return true; },
  });
  ok("the off switch still wins over the pane env", r.suppressed === true && paneArgs === null, JSON.stringify(r));
}

console.log("\nNo pane env: today's window behavior, unchanged:");
{
  const order = [];
  const r = spawnBaton({
    projectDir: subDir, handoffFile: "/x/h.json",
    _env: {},
    _hasPane: () => false,
    _resolveWindow: () => { order.push("detect"); return { windowId: "W-ORIGINAL", tty: "/dev/ttys007" }; },
    _spawnFresh: () => { order.push("spawn"); return true; },
    _armClose: (f, wid) => { order.push(`arm:${wid}`); return true; },
    _spawnPane: () => { order.push("PANE — wrong leg"); return true; },
  });
  ok("window leg ran, original window detected first", order[0] === "detect" && order[1] === "spawn" && order[2] === "arm:W-ORIGINAL", order.join(","));
  ok("the close is armed against the ORIGINAL window", r.spawned === true && r.armed === true && r.windowId === "W-ORIGINAL", JSON.stringify(r));
  ok("the pane leg did not run", !order.includes("PANE — wrong leg"));
}
{
  let paneArgs = null;
  const r = spawnBaton({
    projectDir: subDir, handoffFile: "/x/h.json",
    _env: {},
    _hasPane: () => true,                       // #5643 branch, still env-free
    _resolveWindow: () => { throw new Error("window machinery must not run for a pane project"); },
    _spawnPane: (...a) => { paneArgs = a; return true; },
  });
  ok("a tracked orch row still takes the pane leg (no env needed)", r.pane === true && r.spawned === true && paneArgs !== null && paneArgs[2] === undefined, JSON.stringify(r));
}

// ── 4. the guards on the OTHER window paths (maybeSpawn / spawnFresh) ───────
// These spawn REAL dialogs/windows when the guard is missing, so they cannot be invoked in a
// drill; assert the guard is inside their bodies (the spawnBaton seam above proves the shared
// predicate; this proves the direct callers call it too).
console.log("\nThe direct window callers carry the pane-env guard:");
{
  const src = readFileSync(join(ROOT, "hooks", "lib", "handoff.mjs"), "utf8");
  for (const fn of ["maybeSpawn", "spawnFresh"]) {
    const body = src.slice(src.indexOf(`export function ${fn}(`), src.indexOf("export function", src.indexOf(`export function ${fn}(`) + 10));
    ok(`${fn} refuses under HERDR_PANE_ID`, /paneSurfaceEnv\(\)/.test(body), fn);
  }
}

// ── 5. end to end through the real CLIs (suppressed spawn — no live windows) ─
console.log("\nEnd to end, the CLIs cannot diverge from the resolver:");
function seed(id) {
  writeFileSync(join(BUS, "handoffs", `${id}.json`), JSON.stringify({ id, project: projDir, projectName: id.replace(/-\d+$/, ""), machine: "h", trigger: "manual-baton", stamp: Number(id.split("-").pop()), summary: "SEEDED", gitStatus: "", consumed: false }, null, 2));
}
function run(cli, args, { cwdDir, env = {}, stdin = "", stdio } = {}) {
  // NO process.env passthrough (#6074 bounce): the gate runner — or any seat — may itself live in
  // a herdr pane and export exactly the identity this drill varies (HERDR_PANE_ID, TRANTOR_ORCH,
  // RELAY_PROJECT). Every var the CLIs read is set or blanked here; each case overrides
  // deliberately through `env`. Only the mechanical vars (PATH, TMPDIR) are inherited.
  const r = spawnSync(process.execPath, [join(ROOT, "bin", cli), ...args], {
    input: stdin, encoding: "utf8", timeout: 20000, cwd: cwdDir,
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: w, TMPDIR: process.env.TMPDIR || "/tmp",
      AGENT_BUS_DIR: BUS, RELAY_DATA_DIR: BUS, CLAUDE_PROJECT_DIR: cwdDir,
      TRANTOR_NO_SCROOGE: "1",
      HERDR_ENV: "", HERDR_PANE_ID: "", TRANTOR_ORCH: "",
      RELAY_PROJECT: "", TRANTOR_PROJECT: "", RELAY_SESSION: "", RELAY_AGENT: "",
      ...env,
    },
    ...(stdio ? { stdio } : {}),
  });
  return { out: (r.stdout || "") + (r.stderr || ""), status: r.status };
}
const decoy = "ios-9999999999", real = "crebral-scribe-7777777777";
const handoffs = () => readdirSync(join(BUS, "handoffs")).filter(f => f.endsWith(".json"));
const NO_SPAWN = { TRANTOR_NO_BATON_SPAWN: "1" };   // every e2e case suppresses the spawn; the pane leg is proven at the seam above

mkdirSync(join(BUS, "handoffs"), { recursive: true });
seed(decoy); seed(real);
{
  const r = run("write-handoff.mjs", ["--baton", "--latest"], { cwdDir: subDir, env: { ...NO_SPAWN, RELAY_PROJECT: "" } });
  ok("unregistered subfolder cwd → the cwd fallback still answers (today's behavior)", r.status === 0 && r.out.includes(decoy) && !r.out.includes(real), `exit ${r.status}: ${r.out.slice(0, 160)}`);
}
{
  const r = run("write-handoff.mjs", ["--baton", "--latest"], { cwdDir: subDir, env: { ...NO_SPAWN, RELAY_PROJECT: "crebral-scribe" } });
  ok("RELAY_PROJECT beats the subfolder cwd through the REAL skill path", r.status === 0 && r.out.includes(real) && !r.out.includes(decoy), `exit ${r.status}: ${r.out.slice(0, 160)}`);
}
{
  const before = handoffs();
  const r = run("write-handoff.mjs", ["--baton"], { cwdDir: subDir, env: { ...NO_SPAWN, RELAY_PROJECT: "crebral-scribe" }, stdin: "# AUTHORED\nhandoff body\n" });
  const written = handoffs().filter(f => !before.includes(f));
  ok("an authored handoff is written under the REGISTERED name", r.status === 0 && written.length === 1 && written[0].startsWith("crebral-scribe-"), `exit ${r.status}: ${r.out.slice(0, 160)} wrote ${written}`);
  const rec = JSON.parse(readFileSync(join(BUS, "handoffs", written[0]), "utf8"));
  ok("the record's projectName is the registered one, the dir stays honest", rec.projectName === "crebral-scribe" && rec.project === subDir, JSON.stringify({ projectName: rec.projectName, project: rec.project }));
}
{
  const before = handoffs().length;
  const r = run("baton.mjs", ["--latest"], { cwdDir: subDir, env: { ...NO_SPAWN, RELAY_PROJECT: "crebral-scribe" } });
  ok("`trantor handoff --latest` forwards to the SAME resolution (one path, no divergence)", r.status === 0 && r.out.includes(real) && !r.out.includes(decoy), `exit ${r.status}: ${r.out.slice(0, 160)}`);
  ok("…and wrote nothing new", handoffs().length === before);
}
{
  const r = run("baton.mjs", [], { cwdDir: subDir, env: { ...NO_SPAWN, RELAY_PROJECT: "crebral-scribe" }, stdio: ["ignore", "pipe", "pipe"] });
  ok("plain `trantor handoff` (stdin not a pipe) keeps the AUTO path", r.status === 0 && /handoff saved for crebral-scribe/.test(r.out), `exit ${r.status}: ${r.out.slice(0, 200)}`);
  ok("the auto path also names the REGISTERED project (deferring to the fresh seed is fine — #5648)", /handoff saved for crebral-scribe: .*(crebral-scribe|ios)-\d+\.json/.test(r.out) && !/saved for .*ios-\d+/.test(r.out), r.out.slice(0, 200));
}
{
  // #6218 end to end — the witnessed shape: badge A (crebral-scribe) + cwd B (tiny-timer).
  // The record is B's, the transcript inside it is B's, and ONE warning line names both.
  // HOME is the drill's own, so the transcript lookup can only have found the seeded dir —
  // findTranscript follows the RESOLVED session dir, never a mismatched badge or cwd.
  const bDir = join(w, "tiny-timer"); mkdirSync(bDir, { recursive: true });
  const dashedB = bDir.replace(/\//g, "-");
  const claudeDir = join(w, ".claude", "projects", dashedB); mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, "b-session-123.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "tiny-timer work in flight" } }) + "\n");
  const before = handoffs();
  const r = run("baton.mjs", [], { cwdDir: bDir, env: { ...NO_SPAWN, TRANTOR_ORCH: "crebral-scribe" }, stdio: ["ignore", "pipe", "pipe"] });
  const written = handoffs().filter(f => !before.includes(f));
  ok("#6218: a badged shell in a foreign cwd saves the handoff for the CWD's project",
     r.status === 0 && written.length === 1 && written[0].startsWith("tiny-timer-") && /handoff saved for tiny-timer/.test(r.out),
     `exit ${r.status}: ${r.out.slice(0, 200)} wrote ${written}`);
  ok("#6218: exactly ONE warning line names the badge and the resolved project",
     (r.out.match(/TRANTOR_ORCH=crebral-scribe/g) || []).length === 1 && r.out.includes("tiny-timer"), r.out.slice(0, 300));
  const rec = JSON.parse(readFileSync(join(BUS, "handoffs", written[0]), "utf8"));
  ok("#6218: the record carries the RESOLVED project's transcript",
     rec.projectName === "tiny-timer" && rec.transcript_path.includes(dashedB) && rec.transcript_path.endsWith("b-session-123.jsonl"),
     JSON.stringify({ projectName: rec.projectName, transcript_path: rec.transcript_path }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// Trantor State P5.5 — the gate (TDD §4.8). Suite for lib/state/gate.mjs.
//
// The tests that MATTER here, and why they look like they do:
//   - the memo BUST test re-edits an ALREADY-modified file, so `git status --porcelain` is
//     byte-identical across the edit (asserted!), and the memo must still miss. A suite that
//     only asserts "a dirty tree busts the memo" passes while the porcelain bug is live.
//   - resolution order asserts scoped BEFORE scripts.test, because scripts.test is the full
//     suite and seats collide with sibling seats on fixed ports.
//   - R11 as a behaviour, not a comment: a touched path OUTSIDE the scoped dir stays
//     verified:false even on a green gate.
//
// Every runGate call here runs against a throwaway git repo under .agent-bus-out/ (gitignored),
// with stub gate commands — no real suites, no ports, no collision with sibling seats.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ERR, emptyState } from "../../lib/state/schema.mjs";
import { validateTurn, hasEvidence } from "../../lib/state/validate.mjs";
import { applyTurn } from "../../lib/state/apply.mjs";
import { runGate, resolveGateCommand, resolveBuildCommand, TIMED_OUT_EXIT } from "../../lib/state/gate.mjs";
import { harness, turn } from "./_helpers.mjs";

const { ok, done } = harness();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = join(ROOT, ".agent-bus-out", "gate-fixtures");
mkdirSync(FIXTURES, { recursive: true });

const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });
const write = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };

/** A real git repo with this repo's shape: lib/state/, test/state/ + a stub runner, scripts.test. */
function tempRepo({ slop = null } = {}) {
  const dir = mkdtempSync(join(FIXTURES, "repo-"));
  write(join(dir, ".gitignore"), ".agent-bus-out/\n");
  write(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node test/run.mjs" } }));
  write(join(dir, "lib", "state", "a.mjs"), "export const a = 1;\n");
  write(join(dir, "lib", "state", "b.mjs"), "export const b = 2;\n");
  write(join(dir, "lib", "other", "c.mjs"), "export const c = 3;\n");
  // the scoped form's real target inside the fixture: exits 0 unless the fixture says otherwise
  write(join(dir, "test", "run.mjs"), "console.log('scoped-stub', process.argv.includes('--only') ? 'scoped' : 'FULL');\n");
  write(join(dir, "test", "state", "test-a.mjs"), "import '../../../lib/state/gate.mjs';\n");
  if (slop !== null) write(join(dir, "bin", "slop-gate.mjs"), slop);
  git(["add", "-A"], dir);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], dir);
  return dir;
}

/** Stub gate command: counts invocations in its own file (kept OUTSIDE the repo it gates). */
let stubN = 0;
const stubScript = () => {
  const p = join(FIXTURES, `stub-${process.pid}.mjs`);
  write(p, "import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2], 'x');\nprocess.exit(Number(process.argv[3] || 0));\n");
  return p;
};
const STUB = stubScript();
const stubEnv = (exit = 0) => ({ TRANTOR_STATE_GATE: `node '${STUB}' '${FIXTURES}/count-${process.pid}' ${exit}` });
const stubRuns = () => (existsSync(join(FIXTURES, `count-${process.pid}`)) ? readFileSync(join(FIXTURES, `count-${process.pid}`), "utf8").length : 0);

const porcelain = (cwd) => git(["status", "--porcelain"], cwd).stdout;

console.log("\nshape — runGate returns the record §4.8's driver loop consumes");
{
  const repo = tempRepo();
  write(join(repo, "lib", "state", "a.mjs"), "export const a = 11;\n"); // touched
  const g = runGate({}, { cwd: repo, env: stubEnv(0) });
  for (const k of ["verify", "files", "coverage", "cmd", "exit", "ms", "tail"]) {
    ok(`result carries ${k}`, g[k] !== undefined, JSON.stringify(Object.keys(g)));
  }
  ok("verify.tested is true on green", g.verify.tested === true);
  ok("verify.cmd/exit name the command that ran", g.verify.cmd?.includes("stub-") && g.verify.exit === 0);
  ok("coverage project on the explicit form", g.coverage === "project");
  ok("verify.observed is NEVER set by runGate", !("observed" in g.verify), JSON.stringify(g.verify));
  ok("a memo record for ext._gate comes back", typeof g.memo?.hash === "string" && g.memo.verify?.tested === true);
  ok("and the credited path carries its blob sha", /^[0-9a-f]{40}$/.test(g.files["lib/state/a.mjs"].hash || ""));
}

console.log("\nresolution — scoped BEFORE scripts.test, explicit before both (the port-collision rule)");
{
  const repo = tempRepo(); // package.json scripts.test = "node test/run.mjs" — the FULL suite
  const envScoped = resolveGateCommand({ paths: ["lib/state/a.mjs"] }, { cwd: repo, env: {} });
  ok("all paths under one suite dir → the SCOPED form", envScoped.kind === "scoped" && envScoped.subsystem === "state");
  ok("and the scoped form is not npm test", envScoped.cmd === "node test/run.mjs --only state");
  ok("explicit TRANTOR_STATE_GATE beats the scoped form",
    resolveGateCommand({ paths: ["lib/state/a.mjs"] }, { cwd: repo, env: { TRANTOR_STATE_GATE: "make gate" } }).cmd === "make gate");
  ok("paths spanning two subsystems fall back to scripts.test",
    resolveGateCommand({ paths: ["lib/state/a.mjs", "lib/other/c.mjs"] }, { cwd: repo, env: {} }).kind === "scripts.test");
  ok("no paths → scripts.test", resolveGateCommand({}, { cwd: repo, env: {} }).kind === "scripts.test");
  ok("a path no suite dir covers → scripts.test, never a guessed scope",
    resolveGateCommand({ paths: ["hub/nowhere.mjs"] }, { cwd: repo, env: {} }).kind === "scripts.test");
  const bare = mkdtempSync(join(FIXTURES, "bare-"));
  ok("no env, no scripts.test → none", resolveGateCommand({ paths: ["x.mjs"] }, { cwd: bare, env: {} }).kind === "none");

  ok("build: TRANTOR_STATE_BUILD beats scripts",
    resolveBuildCommand({ cwd: repo, env: { TRANTOR_STATE_BUILD: "make build" } }).cmd === "make build");
  ok("build: no env, no scripts.typecheck/build in this repo → none",
    resolveBuildCommand({ cwd: repo, env: {} }).kind === "none");
}

console.log("\nTHE MEMO BUST TEST — re-edit an ALREADY-modified file: porcelain identical, memo MISSES");
{
  const repo = tempRepo();
  write(join(repo, "lib", "state", "a.mjs"), "export const a = 11;\n"); // 1st edit: now ` M a.mjs`
  const before = porcelain(repo);
  const g1 = runGate({}, { cwd: repo, env: stubEnv(0) }); // green, counter → 1
  ok("first run spawns the gate", stubRuns() === 1 && g1.memoHit === false);
  const g2 = runGate({}, { cwd: repo, env: stubEnv(0), memo: g1.memo }); // same bytes
  ok("unchanged content after a green run → memo HIT, no spawn", g2.memoHit === true && stubRuns() === 1);
  ok("the hit returns the recorded result", g2.verify.tested === true && g2.coverage === g1.coverage);

  write(join(repo, "lib", "state", "a.mjs"), "export const a = 111;\n"); // 2nd edit of the SAME file
  ok("PRECONDITION: porcelain is byte-identical across the re-edit", porcelain(repo) === before,
    JSON.stringify({ before, after: porcelain(repo) }));
  ok("PRECONDITION: HEAD did not move", git(["rev-parse", "HEAD"], repo).stdout === git(["rev-parse", "HEAD"], repo).stdout);
  const g3 = runGate({}, { cwd: repo, env: stubEnv(0), memo: g1.memo });
  ok("the memo MISSES anyway — content moved, the gate re-runs", g3.memoHit === false && stubRuns() === 2);
  ok("and the bust is visible in the hash itself", g3.memo.hash !== g1.memo.hash);

  write(join(repo, "lib", "state", "new.mjs"), "export const n = 1;\n"); // brand-new UNTRACKED file
  const g4 = runGate({}, { cwd: repo, env: stubEnv(0), memo: g3.memo });
  ok("an untracked file busts the memo too (add -A folds it in)", g4.memoHit === false && stubRuns() === 3);

  const g5 = runGate({}, { cwd: repo, env: stubEnv(1), memo: g4.memo }); // red
  const g6 = runGate({}, { cwd: repo, env: stubEnv(1), memo: g5.memo });
  ok("a RED result is never memoised — the gate re-runs", g5.memoHit === false && g6.memoHit === false && stubRuns() === 5);
  rmSync(join(FIXTURES, `count-${process.pid}`), { force: true });
}

console.log("\nGATE_MAX_MS — a timeout is a RED gate, not a missing one");
{
  const repo = tempRepo();
  const sleepy = join(FIXTURES, "sleepy.mjs");
  write(sleepy, "setTimeout(() => {}, 60_000);\n");
  const g = runGate({}, { cwd: repo, env: { TRANTOR_STATE_GATE: `node '${sleepy}'` }, maxMs: 400 });
  ok("timeout exits 124", g.exit === TIMED_OUT_EXIT && g.verify.exit === TIMED_OUT_EXIT);
  ok("so tested is false and the tail says what happened", g.verify.tested === false && /TIMED OUT/.test(g.tail));
}

console.log("\nR11 — coverage: only paths the gate covered get verified; outside scope stays false");
{
  // scoped GREEN run through the real resolution path (no explicit env)
  const repo = tempRepo();
  write(join(repo, "lib", "state", "a.mjs"), "export const a = 11;\n");   // touched, IN scope
  write(join(repo, "bin", "other.mjs"), "export const o = 1;\n");          // touched, OUT of scope
  const g = runGate({ paths: ["lib/state/a.mjs"] }, { cwd: repo, env: {} });
  ok("coverage records the scoped lane", g.coverage === "scoped:test/state");
  ok("the in-scope touched path is credited", g.files["lib/state/a.mjs"]?.verified === true);
  ok("a touched path OUTSIDE the scope stays verified:false — R11, as behaviour",
    JSON.stringify(g.files["bin/other.mjs"]) === JSON.stringify({ touched: true, verified: false }),
    JSON.stringify(g.files["bin/other.mjs"]));
  ok("and carries no hash it never earned", g.files["bin/other.mjs"].hash === undefined);

  const gp = runGate({ paths: ["lib/state/a.mjs"] }, { cwd: repo, env: stubEnv(0) });
  ok("project coverage credits every touched path, including out-of-scope",
    gp.coverage === "project" && gp.files["bin/other.mjs"]?.verified === true);

  const gr = runGate({ paths: ["lib/state/a.mjs"] }, { cwd: repo, env: stubEnv(1) });
  ok("a red gate credits NOTHING", gr.verify.tested === false &&
    Object.values(gr.files).every(f => f.verified === false));
}

console.log("\nslop-gate — always runs where the repo has one; green suite + red slop = RED gate");
{
  const repo = tempRepo({ slop: "console.log('SLOP: fail');\nprocess.exit(3);\n" });
  write(join(repo, "lib", "state", "a.mjs"), "export const a = 11;\n");
  const g = runGate({}, { cwd: repo, env: stubEnv(0) });
  ok("the gate is red despite the green suite", g.exit === 3 && g.verify.tested === false);
  ok("and the tail carries the slop output", /SLOP: fail/.test(g.tail) && /\[slop-gate exit 3\]/.test(g.tail));
  const clean = tempRepo(); // no bin/slop-gate.mjs → skipped, not failed
  write(join(clean, "lib", "state", "a.mjs"), "export const a = 11;\n");
  ok("no slop-gate in the repo → the gate does not invent one", runGate({}, { cwd: clean, env: stubEnv(0) }).exit === 0);
}

console.log("\nthe NEEDS_GATE cure — runGate's shape feeds P0's split, end to end");
{
  const repo = tempRepo();
  write(join(repo, "lib", "state", "a.mjs"), "export const a = 11;\n");
  const state = emptyState(6901, "glm:trantor");
  state.in_flight = [{ id: "x1", text: "the gate", paths: ["lib/state/a.mjs"] }];
  const move = turn([{ move: { id: "x1", from: "in_flight", to: "done" } }]);

  const r1 = validateTurn(state, move, {});
  ok("no gate attempted → NEEDS_GATE, carrying the paths", r1.code === ERR.NEEDS_GATE && r1.gate?.paths?.join() === "lib/state/a.mjs");

  const red = runGate(r1.gate, { cwd: repo, env: stubEnv(1) });
  ok("a red attempt is a runtime record (cmd/exit/tail/coverage) the core can read",
    "cmd" in red && "exit" in red && "tail" in red && "coverage" in red);
  const r2 = validateTurn(state, move, { gate_attempted: { cmd: red.cmd, exit: red.exit, tail: red.tail, coverage: red.coverage } });
  ok("gate ran, evidence still absent → UNVERIFIED_DONE, never NEEDS_GATE again",
    r2.code === ERR.UNVERIFIED_DONE && r2.gate?.tail === red.tail);

  // the cure: evidence lands in STATE through the single apply point (a no-op patch), then the move
  const green = runGate(r1.gate, { cwd: repo, env: stubEnv(0) });
  const evidenced = applyTurn(state, turn([]), { verify: green.verify, files: green.files, gate: green.memo });
  ok("the apply wrote the memo into ext._gate (runtime-owned)",
    evidenced.state.ext._gate?.hash === green.memo.hash && evidenced.state.ext._gate?.ts > 0);
  ok("route (b) now holds in the state itself", hasEvidence(evidenced.state, state.in_flight[0]) === true);
  const r3 = applyTurn(evidenced.state, move, { gate_attempted: green });
  ok("the cured move → done is ACCEPTED", r3.ok === true, JSON.stringify(r3));
  ok("and the done item's path is credited in state",
    r3.state.files["lib/state/a.mjs"]?.verified === true && r3.state.done[0]?.id === "x1");
}

console.log("\nsafety — the scratch index never touches the seat's real index");
{
  const repo = tempRepo();
  write(join(repo, "lib", "state", "a.mjs"), "export const a = 11;\n");
  const realIndex = readFileSync(join(repo, ".git", "index")); // staged state BEFORE any gate
  runGate({}, { cwd: repo, env: stubEnv(0) });
  ok("the real .git/index is byte-identical after a gate run",
    realIndex.equals(readFileSync(join(repo, ".git", "index"))));
  ok("the scratch index lives under .agent-bus-out, as designed",
    existsSync(join(repo, ".agent-bus-out", "gate-index")));
}

done();

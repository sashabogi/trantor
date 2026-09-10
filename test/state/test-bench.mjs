#!/usr/bin/env node
// Trantor State P7 — the bench's own suite (TDD §8, §7.5, §7.3).
//
// A measurement tool is the one kind of code whose bugs are invisible in production: it prints a
// number and the number looks like a number. So this suite is written against the ways this file
// could LIE, not the ways it could crash. Each block below names the lie it is there to catch.
//
//   1. "the baseline was there" — a file on disk that was written after the run it judges. The
//      pre-condition is asserted on HEAD, with the on-disk-but-uncommitted case as the mutation
//      target: delete the committed check and that case flips green.
//   2. "the totals look fine" — a run with an excellent ratio and one zero-cache step. It must
//      fail. Cheap to get wrong: the cache check is the one gate whose failure costs nothing
//      visible.
//   3. "nothing was rejected, so everything passed" — a green run that never tested the rule.
//   4. "the seat is over budget" — an evidence rejection miscounted as malformed output, which
//      would trip the breaker on the healthiest seat there is.
//   5. "item→rev needs a schema field" — it does not; the journal replay is asserted to produce
//      revs from items that carry none.
//   6. "n=1 is a median" — the §8.7 carry-forward must not read as a pass.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { emptyState } from "../../lib/state/schema.mjs";
import { harness } from "./_helpers.mjs";

const { ok, done } = harness();

const ROOT = mkdtempSync(join(tmpdir(), "trantor-state-bench-"));
const BUS = join(ROOT, "bus");
process.env.AGENT_BUS_DIR = BUS;

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BENCH_BIN = join(REPO_ROOT, "bin", "state-bench.mjs");

// Imported after AGENT_BUS_DIR is set, exactly as the sibling suites do: busDir() reads the env on
// every call, so this keeps the paths the test writes identical to the ones the bench reads.
const B = await import("../../bin/state-bench.mjs");

const PROJ = "trantor-bench-test";
const SEAT = "claude:trantor";
const CARD = 6909;

const write = (p, body) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); return p; };
const writeJsonl = (p, rows) => write(p, rows.map(r => JSON.stringify(r)).join("\n") + "\n");

/** A step as the P6 driver records it. Flat cost, healthy cache — the shape a PASSING run has, so
 *  every failure case below differs from it in exactly one way. */
const step = (turn, over = {}) => ({
  turn, ts: 1_780_000_000_000 + turn * 60_000, rev: turn, by: SEAT,
  cost_usd: 0.02, input: 4000, output: 900, cache_read: 30_000, cache_creation: 0,
  action: { continue: true }, rejected: null, verify: null, verified_paths: [], ...over,
});
const runSteps = (n, over = () => ({})) => Array.from({ length: n }, (_, i) => step(i + 1, over(i + 1)));
/** A baseline turn: the same card on the prose path, five times the cost per turn. */
const baseRow = (turn, cost = 0.10) => ({ turn, ts: 1_779_000_000_000 + turn * 60_000, cost_usd: cost, input: 60_000, output: 1500, cache_read: 0, cache_creation: 0 });

// ── 1. the baseline is a PRE-CONDITION, and it is asserted on HEAD ────────────────────────────
//
// The three states an artifact can be in, and only one of them opens the phase.
const gitRepo = (() => {
  const dir = join(ROOT, "repo");
  mkdirSync(join(dir, "docs"), { recursive: true });
  const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
  g("init", "-q");
  g("config", "user.email", "bench@test");
  g("config", "user.name", "bench");
  write(join(dir, "README.md"), "# fixture\n");
  g("add", "-A"); g("commit", "-qm", "root");
  return { dir, git: g };
})();

{
  const r = B.requireBaseline({ project: PROJ, card: CARD, repo: gitRepo.dir });
  ok("gate 1: no artifact at all → NO_BASELINE", r.ok === false && r.code === "NO_BASELINE", JSON.stringify(r));
}

// THE MUTATION TARGET. The artifact is on disk and readable; it is simply not committed, which is
// exactly what a baseline captured after the fact looks like. If requireBaseline ever checks
// existsSync instead of HEAD, this case — and only this case — turns green.
{
  const doc = write(B.baselineDoc(CARD, gitRepo.dir), "# baseline\n");
  writeJsonl(B.baselinePath(PROJ, CARD), [baseRow(1), baseRow(2)]);
  const r = B.requireBaseline({ project: PROJ, card: CARD, repo: gitRepo.dir });
  ok("gate 1: artifact ON DISK but NOT COMMITTED → still NO_BASELINE", r.ok === false && r.code === "NO_BASELINE", `${JSON.stringify(r)} (doc exists: ${existsSync(doc)})`);
}

// Positive control for the assertion above: the ONLY thing that changes is the commit.
{
  gitRepo.git("add", "-A");
  gitRepo.git("commit", "-qm", "baseline");
  const r = B.requireBaseline({ project: PROJ, card: CARD, repo: gitRepo.dir });
  ok("gate 1: committed artifact + rows → passes (positive control)", r.ok === true && r.rows.length === 2, JSON.stringify(r).slice(0, 200));
}

// A table with no measurements behind it is a claim. Committed doc, missing rows → still NO.
{
  rmSync(B.baselinePath(PROJ, 7777), { force: true });
  write(B.baselineDoc(7777, gitRepo.dir), "# baseline\n");
  gitRepo.git("add", "-A"); gitRepo.git("commit", "-qm", "doc only");
  const r = B.requireBaseline({ project: PROJ, card: 7777, repo: gitRepo.dir });
  ok("gate 1: committed table with no per-turn rows → NO_BASELINE_ROWS", r.ok === false && r.code === "NO_BASELINE_ROWS", JSON.stringify(r));
}

// And the pre-condition is a PRE-condition: nothing downstream is measured when it fails.
{
  const v = B.evaluateRun({ project: PROJ, card: 4242, repo: gitRepo.dir });
  ok("gate 1 halts the run: exactly one gate evaluated, no measurement",
    v.ok === false && v.gates.length === 1 && v.gates[0].n === 1 && v.halted === "gate 1", JSON.stringify(v.gates.map(g => g.n)));
}

// ── 2. the cache check, which is what catches silent drift ────────────────────────────────────
{
  const r = B.checkCache(runSteps(9));
  ok("cache: every step after the first reads cached tokens → pass", r.ok === true && r.checked === 8, JSON.stringify(r));
}
{
  const r = B.checkCache([step(1)]);
  ok("cache: one step is not an observation → TOO_FEW_STEPS, not a pass", r.ok === false && r.code === "TOO_FEW_STEPS", JSON.stringify(r));
}
{
  const steps = runSteps(9, (t) => (t === 5 ? { cache_read: 0 } : {}));
  const r = B.checkCache(steps);
  ok("cache: one zero-read step → CACHE_MISS naming the turn", r.ok === false && r.code === "CACHE_MISS" && r.violations.length === 1 && r.violations[0].turn === 5, JSON.stringify(r.violations));
}
// The lie this catches: the totals are excellent, the ratio would sail through gate 4, and the
// preamble drifted anyway. Cost and cache are asserted independently on purpose.
{
  const steps = runSteps(9, (t) => (t === 3 ? { cache_read: 0 } : {}));
  const cost = B.costGate(steps, Array.from({ length: 9 }, (_, i) => baseRow(i + 1)));
  const cache = B.checkCache(steps);
  ok("cache: a run with a PASSING cost ratio still fails on a zero-read step",
    cost.ok === true && cache.ok === false, `cost ${JSON.stringify(cost.ratio)} cache ${cache.code}`);
}

// ── 3. the cost curve, reported as measured ───────────────────────────────────────────────────
{
  const r = B.costGate(runSteps(4), [baseRow(1)]);
  ok("cost: fewer than 8 turns → TOO_FEW_TURNS, never a pass", r.ok === false && r.code === "TOO_FEW_TURNS", JSON.stringify(r.code));
}
{
  const r = B.costGate(runSteps(9), Array.from({ length: 9 }, (_, i) => baseRow(i + 1)));
  ok("cost: flat curve + 5× cheaper → pass, ratio ≈ 5", r.ok === true && Math.abs(r.ratio - 5) < 0.001 && r.basis === "cost_usd", JSON.stringify({ ratio: r.ratio, slope: r.slope }));
}
// The honest-answer case. 2× is the measurement, so 2× is what it reports — and it says NO.
{
  const r = B.costGate(runSteps(9, () => ({ cost_usd: 0.05 })), Array.from({ length: 9 }, (_, i) => baseRow(i + 1)));
  ok("cost: a measured 2× reports 2.00 and FAILS the ≥5× gate", r.ok === false && r.code === "COST_RATIO" && Math.abs(r.ratio - 2) < 0.001, `ratio ${r.ratio} code ${r.code}`);
}
// A cost that climbs with the turn index is the failure the whole design exists to prevent: it
// means the context is growing again. Cheap total, rising curve → still NO.
{
  const steps = runSteps(9, (t) => ({ cost_usd: 0.002 * t * t }));
  const r = B.costGate(steps, Array.from({ length: 9 }, (_, i) => baseRow(i + 1)));
  ok("cost: a rising per-turn curve fails COST_CURVE even when the total is cheap", r.ok === false && r.code === "COST_CURVE", `slope_ratio ${r.slope_ratio} ratio ${r.ratio}`);
}
// The unpriced case, which is the REAL one: CC transcripts record usage and no costUSD. An
// unweighted token ratio would come out near 1× purely because the prose path pays through
// cache_read, so the default is a refusal, and the weighting has to be asked for by name.
{
  const priceless = runSteps(9, () => ({ cost_usd: null }));
  const base = Array.from({ length: 9 }, (_, i) => ({ ...baseRow(i + 1), cost_usd: null }));
  const bare = B.costGate(priceless, base);
  ok("cost: no price on either side and no stated weighting → NO_COST, never a token-shaped guess",
    bare.ok === false && bare.code === "NO_COST" && bare.ratio === null, JSON.stringify({ code: bare.code, ratio: bare.ratio }));
  const weighted = B.costGate(priceless, base, { weights: B.TOKEN_WEIGHTS });
  ok("cost: with the weighting named, the basis is reported as `weighted` and a ratio exists",
    weighted.basis === "weighted" && weighted.ratio !== null && /weighted/.test(weighted.message), JSON.stringify({ basis: weighted.basis, ratio: weighted.ratio }));
  // And the reason the default refuses: cache_read dominates the prose path, so the naive
  // input+output reading of the SAME rows disagrees with the weighted one by a wide margin.
  const naive = (base.reduce((a, r) => a + r.input + r.output, 0)) / (priceless.reduce((a, r) => a + r.input + r.output, 0));
  ok("cost: the naive input+output ratio and the weighted one really do disagree (why NO_COST is the default)",
    Math.abs(naive - weighted.ratio) > 0.5, `naive ${naive.toFixed(2)} vs weighted ${weighted.ratio.toFixed(2)}`);
}
{
  ok("slope: fewer than two points has no slope (null, not a measured 0)", B.fitSlope([3]) === null && B.fitSlope([]) === null);
  ok("slope: a flat series fits 0, a rising one fits +1", B.fitSlope([2, 2, 2, 2]) === 0 && B.fitSlope([0, 1, 2, 3]) === 1);
}

// ── 4. item → rev, by replaying the ops journal, with no new schema field ─────────────────────
{
  const journal = [
    { ts: 1, rev: 1, ops: [{ add: { list: "in_flight", item: { id: "a", text: "wire it" } } }] },
    { ts: 2, rev: 3, ops: [{ move: { id: "a", from: "in_flight", to: "done" } }] },
    { ts: 3, rev: 5, ops: [{ add: { list: "done", item: { id: "b", text: "second" } } }] },
    { ts: 4, rev: 6, ops: [{ move: { id: "a", from: "done", to: "in_flight" } }] },
    { ts: 5, rev: 7, ops: [{ move: { id: "a", from: "in_flight", to: "done" } }] },
    { ts: 6, rev: 8, ops: [{ add: { list: "done", item: { id: "c", text: "third" } } }, { remove: { list: "done", id: "c" } }] },
  ];
  const revs = B.itemRevsFromJournal(journal);
  ok("replay: an item landed by `move` takes the rev of the patch that moved it", revs.get("a") === 7, `got ${revs.get("a")}`);
  ok("replay: an item added straight to done takes that patch's rev", revs.get("b") === 5, `got ${revs.get("b")}`);
  ok("replay: an item that left done has no landing rev", revs.has("c") === false);
  // The claim in the card: items carry no rev and must not gain one. The rev comes from the
  // journal ENTRY, never from the item, and this asserts the items in the fixture have none.
  const items = journal.flatMap(e => e.ops.map(o => o.add?.item).filter(Boolean));
  ok("replay: no item in the journal carries a `rev` — the schema gained no field",
    items.length === 3 && items.every(i => !("rev" in i)));
}

// ── 5. the evidence pipeline, and the half that matters ───────────────────────────────────────
const donePair = () => {
  const state = emptyState(CARD, SEAT);
  state.done = [{ id: "a", text: "wire the bench", paths: ["bin/state-bench.mjs"] }];
  const journal = [{ ts: 1, rev: 4, ops: [{ move: { id: "a", from: "in_flight", to: "done" } }] }];
  return { state, journal };
};
{
  const { state, journal } = donePair();
  const steps = [
    step(3, { rev: 3, rejected: { code: "UNVERIFIED_DONE", at: "done" } }),
    step(4, { rev: 4, verify: { cmd: "node test/run.mjs --only state", exit: 0 }, verified_paths: ["bin/state-bench.mjs"] }),
  ];
  const r = B.evidenceAudit({ state, journal, steps });
  ok("evidence: done item verified at its landing rev, with a real rejection on the run → pass", r.ok === true, JSON.stringify(r));
}
// The lie: a run where nothing was ever rejected shows a green path staying green. It has not
// tested the rule, and §8.6 says so.
{
  const { state, journal } = donePair();
  const steps = [step(4, { rev: 4, verify: { cmd: "npm test", exit: 0 }, verified_paths: ["bin/state-bench.mjs"] })];
  const r = B.evidenceAudit({ state, journal, steps });
  ok("evidence: nothing ever rejected → NEVER_REJECTED, not a pass", r.ok === false && r.code === "NEVER_REJECTED", JSON.stringify(r.code));
}
{
  const { state, journal } = donePair();
  const steps = [
    step(3, { rev: 3, rejected: { code: "NEEDS_GATE", at: "done" } }),
    step(4, { rev: 4, verify: { cmd: "npm test", exit: 1 }, verified_paths: [] }),
  ];
  const r = B.evidenceAudit({ state, journal, steps });
  ok("evidence: a red gate at the landing rev → NO_GREEN_GATE", r.ok === false && r.code === "NO_GREEN_GATE", JSON.stringify(r.items));
}
{
  const { state, journal } = donePair();
  const steps = [
    step(3, { rev: 3, rejected: { code: "UNVERIFIED_DONE", at: "done" } }),
    step(4, { rev: 4, verify: { cmd: "npm test", exit: 0 }, verified_paths: ["lib/state/store.mjs"] }),
  ];
  const r = B.evidenceAudit({ state, journal, steps });
  ok("evidence: green gate crediting OTHER paths → UNCREDITED_PATH", r.ok === false && r.code === "UNCREDITED_PATH", JSON.stringify(r.items));
}
{
  const { state } = donePair();
  const steps = [step(4, { rev: 4, verify: { cmd: "npm test", exit: 0 }, rejected: { code: "UNVERIFIED_DONE", at: "done" }, verified_paths: ["bin/state-bench.mjs"] })];
  const r = B.evidenceAudit({ state, journal: [], steps });
  ok("evidence: a done item with no landing patch in the journal → NO_REV, never waved through", r.ok === false && r.items[0].code === "NO_REV", JSON.stringify(r.items));
}

// ── 6. §7.3 — malformed output and a red gate are DIFFERENT numbers ───────────────────────────
//
// The lie this catches is the expensive one: counting UNVERIFIED_DONE as malformed trips the
// circuit breaker on a seat writing perfect patches against a failing test, and drops it back to
// the transcript path precisely when the evidence loop is working.
{
  const records = Array.from({ length: 50 }, (_, i) => ({ seat: SEAT, code: i < 40 ? "UNVERIFIED_DONE" : null }));
  const r = B.classifyPatches(records);
  const c = r.classes[0];
  ok("patches: 40 red gates out of 50 are 0% malformed and stay within budget",
    r.ok === true && c.evidence === 40 && c.malformed === 0 && c.rate === 0, JSON.stringify(c));
}
{
  const records = Array.from({ length: 50 }, (_, i) => ({ seat: SEAT, code: i < 5 ? "SCHEMA" : null, retry_code: i < 5 ? "SCHEMA" : null }));
  const r = B.classifyPatches(records);
  ok("patches: 10% malformed on a schema-enforced seat → OVER_BUDGET (budget 2%)",
    r.ok === false && r.code === "OVER_BUDGET" && Math.abs(r.classes[0].rate - 0.1) < 1e-9, JSON.stringify(r.classes[0]));
}
{
  const records = Array.from({ length: 10 }, () => ({ seat: SEAT, code: "BAD_ACTION", retry_code: null }));
  const r = B.classifyPatches(records);
  ok("patches: malformed once, well-formed on the retry → not counted (the budget is AFTER one retry)",
    r.ok === true && r.classes[0].malformed === 0 && r.classes[0].recovered === 10, JSON.stringify(r.classes[0]));
}
{
  const r = B.classifyPatches(Array.from({ length: 20 }, () => ({ seat: "glm:trantor", code: "SCHEMA" })));
  ok("patches: a prompt-only seat is held to its own 10% budget and named as its own class",
    r.classes[0].class === "prompt" && r.classes[0].budget === 0.10 && r.ok === false, JSON.stringify(r.classes[0]));
  ok("patches: seat class comes from what the CLI enforces", B.seatClass("claude:trantor") === "enforced" && B.seatClass("deepseek:trantor") === "prompt");
}
{
  ok("patches: no records is not a 0% rate → NO_RECORDS", B.classifyPatches([]).code === "NO_RECORDS");
}

// ── 7. the mid-run disturbance ────────────────────────────────────────────────────────────────
{
  const r = B.disturbanceCheck(runSteps(9));
  ok("disturb: a run with no disturbance did not pass §8.5 → NO_DISTURBANCE", r.ok === false && r.code === "NO_DISTURBANCE");
}
{
  const steps = [...runSteps(5), step(6, { disturbed: true }), step(7)];
  const r = B.disturbanceCheck(steps);
  ok("disturb: the next step acts on current state → pass", r.ok === true, JSON.stringify(r.cases));
}
{
  const steps = [...runSteps(5), step(6, { disturbed: true }), step(7, { input: 200_000 })];
  const r = B.disturbanceCheck(steps);
  ok("disturb: a re-read burst → REREAD_BURST", r.ok === false && r.code === "REREAD_BURST", JSON.stringify(r.cases));
}
// The failure the token bound cannot see: one small Read, because the state block did not carry.
{
  const steps = [...runSteps(5), step(6, { disturbed: true }), step(7, { input: 3800, action: { tool: "Read", input: { file_path: "/x" } } })];
  const r = B.disturbanceCheck(steps);
  ok("disturb: a small re-orientation READ still fails, under the token bound → REORIENTED", r.ok === false && r.code === "REORIENTED", JSON.stringify(r.cases));
}

// ── 8. the Phase-1 handoff field-drop gate ────────────────────────────────────────────────────
{
  const src = emptyState(CARD, SEAT);
  src.task = "P7";
  const rec = { id: "h1", projectName: PROJ, gitStatus: " M bin/state-bench.mjs", state: JSON.parse(JSON.stringify(src)) };
  const r = B.handoffAudit([rec], { readSource: () => ({ state: src, derived: false }) });
  ok("handoffs: the record carries the writer's whole field set → clean", r.ok === true, JSON.stringify(r.results));
}
{
  const src = emptyState(CARD, SEAT);
  src.ext = { phase: "P7", gate: "8.4" };
  const dropped = JSON.parse(JSON.stringify(src));
  delete dropped.ext.phase;   // #6528, in miniature: the capping ate a field
  const rec = { id: "h2", projectName: PROJ, gitStatus: " M x", state: dropped };
  const r = B.handoffAudit([rec], { readSource: () => ({ state: src, derived: false }) });
  ok("handoffs: a dropped field is named, not summarised away", r.ok === false && r.results[0].code === "FIELD_DROP" && r.results[0].dropped.includes("ext.phase"), JSON.stringify(r.results[0]));
}
{
  const r = B.handoffAudit([{ id: "h3", gitStatus: " M lib/state/store.mjs", state: null }]);
  ok("handoffs: null state while the worktree was dirty → STATE_NULL_DIRTY", r.ok === false && r.results[0].code === "STATE_NULL_DIRTY");
}
{
  const r = B.handoffAudit([{ id: "h4", gitStatus: "", state: null }]);
  ok("handoffs: null state on a clean worktree is not a drop", r.ok === true && r.results[0].code === "STATE_NULL_CLEAN");
}
{
  const r = B.handoffAudit([{ id: "h5", gitStatus: "", state: { schema_version: 3, card: "not a number" } }]);
  ok("handoffs: a state that does not validate fails on SCHEMA", r.ok === false && r.results[0].code === "SCHEMA");
}
{
  // The re-derived comparison collapses dynamic keys, or every file git touched since the handoff
  // would read as a dropped field — noise dressed as a failure.
  const src = emptyState(CARD, SEAT);
  src.files = { "a.mjs": { touched: true, verified: false } };
  const rec = { id: "h6", gitStatus: " M a", state: { ...JSON.parse(JSON.stringify(src)), files: { "b.mjs": { touched: true, verified: false } } } };
  const r = B.handoffAudit([rec], { readSource: () => ({ state: src, derived: true }) });
  ok("handoffs: a re-derived source compares the COLLAPSED path set, so a moved file is not a false drop", r.ok === true, JSON.stringify(r.results[0]));
}

// ── 9. §8.7 — one card is an anecdote ─────────────────────────────────────────────────────────
{
  const r = B.turnsGate([{ card: 1, state: runSteps(9), baseline: [baseRow(1)] }]);
  ok("turns: n=1 → CARRY_FORWARD and NOT a pass", r.ok === false && r.code === "CARRY_FORWARD" && r.n === 1, JSON.stringify(r));
}
{
  const pair = (card, s, b) => ({ card, state: runSteps(s), baseline: Array.from({ length: b }, (_, i) => baseRow(i + 1)) });
  const r = B.turnsGate([pair(1, 9, 6), pair(2, 8, 7), pair(3, 10, 5)]);
  ok("turns: n=3 with a higher state median → pass", r.ok === true && r.state_median === 9 && r.baseline_median === 6, JSON.stringify(r));
}
{
  const pair = (card, s, b) => ({ card, state: runSteps(s), baseline: Array.from({ length: b }, (_, i) => baseRow(i + 1)) });
  const r = B.turnsGate([pair(1, 4, 9), pair(2, 3, 8), pair(3, 5, 10)]);
  ok("turns: fewer turns per card on the state path → FEWER_TURNS", r.ok === false && r.code === "FEWER_TURNS", JSON.stringify(r));
}
{
  const rows = [{ turn: 1 }, { turn: 2 }, { turn: 3, cut: true }, { turn: 4 }];
  ok("turns: counting stops at the FIRST forced cut", B.turnsBeforeCut(rows) === 2, String(B.turnsBeforeCut(rows)));
  ok("turns: a card that ran to its own end scores its full length", B.turnsBeforeCut([{ turn: 1 }, { turn: 2 }]) === 2);
}

// ── 10. the transcript decomposition the baseline is built on ─────────────────────────────────
{
  const t = join(ROOT, "transcript.jsonl");
  const user = (text) => ({ type: "user", timestamp: "2026-09-09T10:00:00Z", message: { content: [{ type: "text", text }] } });
  const toolResult = () => ({ type: "user", timestamp: "2026-09-09T10:00:01Z", message: { content: [{ type: "tool_result", content: "ok" }] } });
  const asst = (i, o, cr) => ({ type: "assistant", timestamp: "2026-09-09T10:00:02Z", costUSD: 0.01, message: { usage: { input_tokens: i, output_tokens: o, cache_read_input_tokens: cr } } });
  writeJsonl(t, [
    user("turn one"), asst(100, 10, 0), toolResult(), asst(120, 12, 900), toolResult(), asst(130, 8, 1000),
    user("turn two"), asst(200, 20, 2000),
    user("turn three"), asst(300, 30, 3000), toolResult(), asst(310, 5, 3100),
  ]);
  // The DEFAULT unit is one model call, because that is what a state-path step is. Six assistant
  // rows are six rows, not three prompts — grouping by prompt is the reading that erases the curve.
  const calls = B.perTurnFromTranscript(t);
  ok("transcript: the default unit is one MODEL CALL, so six assistant rows are six turns", calls.length === 6, `got ${calls.length}`);
  ok("transcript: each call row carries exactly its own usage", calls[0].input === 100 && calls[1].cache_read === 900 && calls[0].assistant_rows === 1, JSON.stringify(calls.slice(0, 2)));
  const rows = B.perTurnFromTranscript(t, { unit: "prompt" });
  ok("transcript: --unit prompt groups by user prompt, and a tool_result is not a prompt", rows.length === 3, `got ${rows.length}`);
  ok("transcript: a prompt turn sums every assistant row inside it", rows[0].input === 350 && rows[0].output === 30 && rows[0].assistant_rows === 3, JSON.stringify(rows[0]));
  ok("transcript: costUSD sums per turn when the rows carry it", Math.abs(rows[0].cost_usd - 0.03) < 1e-9, String(rows[0].cost_usd));
  const t2 = writeJsonl(join(ROOT, "unpriced.jsonl"), [
    { type: "user", message: { content: [{ type: "text", text: "x" }] } },
    { type: "assistant", message: { usage: { input_tokens: 5, output_tokens: 1 } } },
  ]);
  const un = B.perTurnFromTranscript(t2);
  ok("transcript: no costUSD → cost_usd stays null, and totals refuse to sum a partial price",
    un[0].cost_usd === null && B.totals(un).cost_usd === null, JSON.stringify(un));
  ok("transcript: a missing file is null, distinct from an empty one", B.perTurnFromTranscript(join(ROOT, "nope.jsonl")) === null);
  ok("jsonl: a missing file is null and an empty one is [] — never recorded vs recorded nothing",
    B.readJsonl(join(ROOT, "nope.jsonl")) === null && Array.isArray(B.readJsonl(write(join(ROOT, "empty.jsonl"), ""))));
}

// ── 11. end to end, through the actual CLI ────────────────────────────────────────────────────
//
// The unit assertions above prove the functions; these prove the EXIT CODE, which is the only part
// of a gate that anything downstream reads.
const bench = (...args) => spawnSync(process.execPath, [BENCH_BIN, "--project", PROJ, ...args], {
  encoding: "utf8", env: { ...process.env, AGENT_BUS_DIR: BUS },
});
{
  const r = bench("--run", "--card", "4242", "--repo", gitRepo.dir);
  ok("cli: --run with no committed baseline exits 1 and says so", r.status === 1 && /NO_BASELINE|baseline/i.test(r.stdout + r.stderr), `status ${r.status}\n${(r.stdout + r.stderr).slice(0, 300)}`);
}
{
  const r = bench("--run", "--card", String(CARD), "--repo", gitRepo.dir);
  ok("cli: baseline committed but no state run recorded → exits 1 on NO_RUN, not 0",
    r.status === 1 && /NO_RUN|has not recorded/.test(r.stdout + r.stderr), `status ${r.status}\n${(r.stdout + r.stderr).slice(0, 400)}`);
}
{
  const t = writeJsonl(join(ROOT, "cap.jsonl"), [
    { type: "user", message: { content: [{ type: "text", text: "one" }] } },
    { type: "assistant", timestamp: "2026-09-09T10:00:00Z", costUSD: 0.5, message: { usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0 } } },
  ]);
  const r = bench("--baseline", "--card", "5555", "--transcript", t, "--repo", gitRepo.dir);
  const doc = B.baselineDoc(5555, gitRepo.dir);
  ok("cli: --baseline writes both halves and tells the operator to commit the table",
    r.status === 0 && existsSync(doc) && existsSync(B.baselinePath(PROJ, 5555)) && /COMMIT/.test(r.stdout), `status ${r.status}\n${r.stdout.slice(0, 300)}`);
  ok("cli: the committed table carries the measured per-turn rows", /\| 1 \| 0\.5000 \| 1000 \|/.test(readFileSync(doc, "utf8")), readFileSync(doc, "utf8").slice(0, 400));
}
{
  const r = bench("--baseline", "--card", "5556", "--repo", gitRepo.dir);
  ok("cli: --baseline without a transcript refuses (usage), never estimates", r.status === 2 && /transcript/.test(r.stderr), `status ${r.status} ${r.stderr.slice(0, 200)}`);
}
{
  const r = bench("--patches", "--from", join(ROOT, "no-such.jsonl"));
  ok("cli: --patches with nothing recorded exits 1 — an unmeasured budget is not a met budget", r.status === 1, `status ${r.status}`);
}
{
  const from = writeJsonl(join(ROOT, "patches.jsonl"), Array.from({ length: 20 }, () => ({ seat: SEAT, code: "UNVERIFIED_DONE" })));
  const r = bench("--patches", "--from", from);
  ok("cli: --patches reports the two classes separately and exits 0 on red gates alone",
    r.status === 0 && /NOT counted/.test(r.stdout), `status ${r.status}\n${r.stdout.slice(0, 400)}`);
}
{
  const r = bench("--turns");
  ok("cli: --turns with no cards exits 1 (carry forward, not a pass)", r.status === 1 && /CARRY|carr/i.test(r.stdout), `status ${r.status}\n${r.stdout.slice(0, 200)}`);
}
{
  const r = spawnSync(process.execPath, [BENCH_BIN], { encoding: "utf8", env: { ...process.env, AGENT_BUS_DIR: BUS } });
  ok("cli: no arguments prints the usage and exits 0", r.status === 0 && /state-bench/.test(r.stdout), `status ${r.status}`);
  const bad = bench("--nonsense");
  ok("cli: an unrecognised flag exits 2 rather than measuring something else", bad.status === 2, `status ${bad.status}`);
}
{
  // The report is a rendering of the verdict, so a NO verdict must render as a NO.
  const v = B.evaluateRun({ project: PROJ, card: 4242, repo: gitRepo.dir });
  const md = B.renderReport(v);
  ok("report: a failing verdict renders **NO**, with the halting gate named", /verdict \*\*NO\*\*/.test(md) && /halted at gate 1/.test(md), md.slice(0, 300));
}

// ── 12. the cut row: honest, needed by §8.7, and not a measurement (#7135) ────────────────────
//
// The lie this catches: a turn SIGKILLed at the 20-minute box still records a row (cost_usd null,
// cache_read 0, cut true). Read as a measurement, that one row poisons everything downstream —
// gate 3 reports its 0 as CACHE_MISS (a cut is not drift) and totals() nulls cost_usd for the
// WHOLE run because one row is unpriced, silently downgrading a measured-dollar result to an
// estimate. Read as nothing at all, §8.7 loses the cut it exists to count. Both readings are
// wrong; the row is evidence about the box, not about the design.
{
  const r = B.measurableSteps([step(1), step(2, { cut: true }), step(3)]);
  ok("cut: measurableSteps drops cut rows and keeps everything else, in order",
    r.length === 2 && r[0].turn === 1 && r[1].turn === 3, JSON.stringify(r.map(s => s.turn)));
  ok("cut: measurableSteps tolerates a non-array", Array.isArray(B.measurableSteps(null)) && B.measurableSteps(undefined).length === 0);
}
// The positive half: 9 good steps plus the boxed turn. The run must still price from cost_usd
// (basis cost_usd, a real ratio) and gate 3 must not report the cut row's zero as a miss.
{
  const cutRow = step(10, { rev: null, cost_usd: null, cache_read: 0, cache_creation: 0, input: 0, output: 0, cut: true });
  const steps = [...runSteps(9), cutRow];
  const base = Array.from({ length: 9 }, (_, i) => baseRow(i + 1));
  const cache = B.checkCache(steps);
  ok("cut: a boxed turn's cache_read 0 is NOT a CACHE_MISS — a cut is not drift",
    cache.ok === true && cache.checked === 8, JSON.stringify({ ok: cache.ok, code: cache.code, checked: cache.checked }));
  const cost = B.costGate(steps, base);
  ok("cut: one unpriced cut row does not void the whole run's cost basis",
    cost.ok === true && cost.basis === "cost_usd" && cost.run.cost_usd !== null && cost.run.turns === 9 && Math.abs(cost.ratio - 5) < 0.001,
    JSON.stringify({ ok: cost.ok, basis: cost.basis, run_cost: cost.run.cost_usd, turns: cost.run.turns, ratio: cost.ratio }));
}
// THE NEGATIVE HALF, and the one this section exists for: the SAME zero cache_read on a step that
// was NOT cut must still fail gate 3. Without this assertion the gate has been taught to ignore
// the exact failure it exists to catch, and it will pass forever looking healthy.
{
  const steps = [...runSteps(9), step(10, { cache_read: 0 })];
  const r = B.checkCache(steps);
  ok("cut: a genuine cache_read 0 on a NON-cut step still FAILS gate 3 as CACHE_MISS",
    r.ok === false && r.code === "CACHE_MISS" && r.violations.length === 1 && r.violations[0].turn === 10, JSON.stringify(r.violations));
}
// The disturbance gate must not pass on a boxed turn either: the row after the marker was cut, so
// the recovery step was never observed — NO_NEXT_STEP, not a pass on zeroed measurements.
{
  const steps = [...runSteps(5), step(6, { disturbed: true }), step(7, { cost_usd: null, cache_read: 0, input: 0, output: 0, cut: true })];
  const r = B.disturbanceCheck(steps);
  ok("cut: a disturbance whose next step was cut is NO_NEXT_STEP, not a pass",
    r.ok === false && r.code === "NO_NEXT_STEP", JSON.stringify(r.cases));
}
// And §8.7 keeps the full record: the cut row is still there to be found.
{
  const rows = [...runSteps(9), step(10, { cut: true })];
  ok("cut: §8.7 still sees every row — counting stops at the cut the measurement gates ignore",
    B.turnsBeforeCut(rows) === 9 && B.turnsGate([{ card: 1, state: rows, baseline: [baseRow(1)] }]).cards[0].state === 9,
    `turnsBeforeCut ${B.turnsBeforeCut(rows)}`);
}

rmSync(ROOT, { recursive: true, force: true });
done();

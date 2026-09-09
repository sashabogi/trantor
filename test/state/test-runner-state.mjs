#!/usr/bin/env node
/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: the suite feeds parseEnvelope the shapes a
   CLI release can actually print — a truncated read, an error blob, a string result — which means
   handing a decoder values of the wrong type on purpose. */
// Trantor State P6 — the runner wiring (TDD §4.1, §4.8, §7.3).
//
// Six things this suite exists to hold, and each is a claim the card said was easy to get subtly
// wrong:
//   0. FLAG OFF IS BYTE-IDENTICAL — proven against the shipped command strings, not by reading.
//   1. THE §4.1 ORDER — read → assemble → cli → tier 1 → apply → commit → promote → act.
//   2. TIER 1 EXPIRES CREDITS — the live half of R12; without it `verified` goes monotonic-true in
//      production while every unit test still passes.
//   3. THE NEEDS_GATE CURE — one gate run, re-entered with gate_attempted; a red gate yields
//      UNVERIFIED_DONE with the tail, never a second NEEDS_GATE.
//   4. A REJECTED PATCH STOPS AT STEP ONE — nothing committed, nothing promoted, nothing executed.
//   5. STALE, and the breaker's two classes.
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ERR, emptyState } from "../../lib/state/schema.mjs";
import { applyTurn } from "../../lib/state/apply.mjs";
import { assemble, STATE_DELIM } from "../../lib/state/assemble.mjs";
import { STALE } from "../../lib/state/store.mjs";
import {
  BREAKER_WINDOW, TURN_RESULT_SCHEMA, breakerVerdict, describeTurn, hasJsonSchemaFlag,
  mergeFiles, parseEnvelope, recordStep, rejectionObservation, renderCardTail, runStep, tier1Files,
} from "../../lib/state/driver.mjs";
import { harness } from "./_helpers.mjs";

const { ok, done } = harness();
const RUNNER = readFileSync(new URL("../../bin/crew-runner.mjs", import.meta.url), "utf8");

// ── 0. the flag, and what OFF means ───────────────────────────────────────────────────────────
//
// The card's first item: "flag off = today's path byte-identical, proven by test not by reading".
// So the assertion is against the literal strings the runner ships, character for character. A
// refactor that "tidies" the transcript rows fails here, which is the point.
console.log("\n0. flag off leaves the transcript path byte-identical");
const CLAUDE_FIRST = 'first: `claude{M} -p "$(cat {P})" --dangerously-skip-permissions`';
const CLAUDE_NEXT = 'next:  `claude -c{M} -p "$(cat {P})" --dangerously-skip-permissions`';
ok("the pre-Phase-2a `first` row is untouched", RUNNER.includes(CLAUDE_FIRST));
ok("the pre-Phase-2a `next` row is untouched — `-c`, no json flags", RUNNER.includes(CLAUDE_NEXT));
ok("the state row is a THIRD row, not a rewrite of either",
  RUNNER.includes("stateNext:") && RUNNER.includes("--json-schema"));
ok("the state row drops `-c` (§4.6: the resumed transcript is what this path exists to stop)",
  /stateNext: `claude\{M\} -p "\$\(cat \{P\}\)"[^`]*`/.test(RUNNER)
  && !/stateNext: `claude -c/.test(RUNNER));
ok("nothing selects the state row except opts.state", RUNNER.includes("if (opts.state && cli.stateNext) cmd = cli.stateNext;"));
ok("and the flag is the only door into state mode",
  RUNNER.includes('const STATE_FLAG_ON = process.env[STATE_ENV] === "1";'));
// {S} is the schema path. It appears in exactly ONE command template, so the unconditional
// replaceAll that carries it is a no-op on every other row — which is what byte-identical has to
// mean once a substitution has been added to a shared line. Comments are stripped first: a
// sentence about {S} is not a command that carries it.
const CODE = RUNNER.split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
const CMD_ROWS = [...CODE.matchAll(/(first|next|stateNext):\s*`([^`]*)`/g)].map(m => ({ row: m[1], cmd: m[2] }));
ok("every CLI command template is accounted for", CMD_ROWS.length >= 10, String(CMD_ROWS.length));
ok("`{S}` occurs in exactly one of them, and it is stateNext",
  CMD_ROWS.filter(r => r.cmd.includes("{S}")).map(r => r.row).join() === "stateNext",
  CMD_ROWS.filter(r => r.cmd.includes("{S}")).map(r => r.row).join());
ok("no transcript-path row mentions --output-format or --json-schema",
  CMD_ROWS.filter(r => r.row !== "stateNext").every(r => !r.cmd.includes("--json-schema") && !r.cmd.includes("--output-format")));
ok("the state path is claude-only (§7.3: the only CLI that can enforce the grammar)",
  RUNNER.includes('if (AGENT !== "claude")'));
ok("and it probes for --json-schema rather than assuming a version (§6)",
  RUNNER.includes("hasJsonSchemaFlag("));
ok("a cut state step takes no prose follow-up — TIME_BOX_PROMPT is not a TurnResult prompt",
  RUNNER.includes("if (cut && !inFollowUp && !opts.state) {"));
ok("an empty ERRF on a state step is not 'empty-output' — the answer went to the envelope",
  RUNNER.includes("!lastErrText.trim() && !lastEnvelope.trim()"));

console.log("\n   the schema handed to --json-schema is generated, not hand-typed");
const listEnum = TURN_RESULT_SCHEMA.properties.patch.items.properties.add.properties.list.enum;
ok("its list enum comes from LISTS (a fifth list cannot drift out of the grammar)",
  JSON.stringify(listEnum) === JSON.stringify(["done", "in_flight", "next", "blockers"]));
ok("action carries exactly the §4.6 collapse — done | ask | continue, no tool variant",
  JSON.stringify(Object.keys(TURN_RESULT_SCHEMA.properties.action.properties)) === JSON.stringify(["done", "ask", "continue"]));
ok("it is serialisable, because the runner writes it to the file the CLI reads",
  typeof JSON.stringify(TURN_RESULT_SCHEMA) === "string");

console.log("\n   the CLI probe reads --help, and no flag means OFF");
ok("a help text carrying the flag enables it", hasJsonSchemaFlag(() => ({ status: 0, stdout: "  --json-schema <schema>  JSON Schema" })) === true);
ok("a help text without it does not", hasJsonSchemaFlag(() => ({ status: 0, stdout: "  --output-format <fmt>" })) === false);
ok("and a probe that throws is a NO, never a maybe", hasJsonSchemaFlag(() => { throw new Error("ENOENT"); }) === false);

// ── the fakes ─────────────────────────────────────────────────────────────────────────────────

const ENV = (turn, usage = {}) => JSON.stringify({
  type: "result", subtype: "success", is_error: false, result: turn,
  total_cost_usd: 0.01,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, ...usage },
});

/** A driver harness whose every side effect is recorded, so `trace` can be read back as fact. */
function rig({ state, cliTurns, gate, commitResults, promoteResult } = {}) {
  const seen = { commits: [], promotes: [], executed: [], appended: [], gates: 0, prompts: [], applyCtx: [] };
  const base = state || emptyState(6969, "claude:trantor");
  let commitCount = 0;
  let readCount = 0;
  const turns = Array.isArray(cliTurns) ? [...cliTurns] : [cliTurns];
  const deps = {
    readState: () => { readCount++; return { ok: true, state: structuredClone(base), path: "/x", created: false, migrated: false, recovered: null }; },
    assemble: (parts) => { seen.prompts.push(parts); return assemble(parts); },
    callCli: async () => ({ exit: 0, stdout: ENV(turns.length > 1 ? turns.shift() : turns[0]) }),
    gitTouched: () => ["lib/state/driver.mjs"],
    hashPaths: (paths) => new Map(paths.map(p => [p, "MOVED"])),
    applyTurn: (s, t, ctx) => { seen.applyCtx.push(ctx); return applyTurn(s, t, ctx); },
    runGate: () => { seen.gates++; return gate; },
    commit: (s, rev) => {
      seen.commits.push({ rev, stateRev: s.rev });
      const r = commitResults ? commitResults[commitCount] : null;
      commitCount++;
      return r || { ok: true, rev: s.rev, path: "/x" };
    },
    promote: async (s, plan) => { seen.promotes.push(plan); return promoteResult || { ok: true, sent: true, hash: "H1", note: "n", state: s }; },
    executeAction: (a) => { seen.executed.push(a); },
    appendJsonl: (path, row) => { seen.appended.push({ path, row }); return path; },
  };
  return { deps, seen, base, reads: () => readCount };
}

const CWD = process.cwd();

// ── 1. the §4.1 order ─────────────────────────────────────────────────────────────────────────
console.log("\n1. the §4.1 order, asserted rather than described");
{
  const state = emptyState(6969, "claude:trantor");
  const r = rig({ state, cliTurns: { patch: [{ set: { field: "task", value: "P6" } }], action: { continue: true } } });
  const out = await runStep({
    seat: "claude:trantor", card: 6969, project: "trantor", cwd: CWD,
    preamble: "PRE", tail: "log", observation: "obs", now: 1234, deps: r.deps,
  });
  ok("the step is accepted", out.ok === true, out.message);
  ok("read → assemble → cli → tier1 → apply → commit → promote → execute, in that order",
    out.trace.join(" ") === "readState assemble cli tier1 applyTurn commit promote execute",
    out.trace.join(" "));
  ok("commit is a compare-and-swap against the rev the state was READ at",
    r.seen.commits[0].rev === state.rev && r.seen.commits[0].stateRev === state.rev + 1);
  ok("promote runs after the commit and receives the PLAN, not a note", Array.isArray(r.seen.promotes[0]));
  ok("execute runs last, on the action the seat sent", r.seen.executed.length === 1 && r.seen.executed[0].continue === true);
  ok("the confirmed promotion hash is carried forward for the next turn (§4.7)", out.promoted === "H1");

  const prompt = assemble(r.seen.prompts[0]);
  ok("the assembled prompt puts the preamble first, byte-identical (§4.6)",
    prompt.slice(0, prompt.indexOf(STATE_DELIM)) === "PRE");
}

// ── 2. tier 1: the live half of R12 ───────────────────────────────────────────────────────────
console.log("\n2. TIER 1 sets touched from git and EXPIRES a credit whose bytes moved");
{
  const state = emptyState(1, "s");
  state.files["lib/a.mjs"] = { touched: true, verified: true, hash: "SHA_OLD" };
  state.files["lib/b.mjs"] = { touched: true, verified: true, hash: "SHA_SAME" };
  const files = tier1Files(state, CWD, {
    gitTouched: () => ["lib/a.mjs", "lib/new.mjs"],
    hashPaths: (paths) => new Map(paths.map(p => [p, p === "lib/b.mjs" ? "SHA_SAME" : "SHA_MOVED"])),
  });
  ok("git's paths are marked touched", files["lib/new.mjs"].touched === true && files["lib/a.mjs"].touched === true);
  ok("tier 1 never SETS verified — touching a file is not evidence that it works",
    Object.values(files).every(f => f.verified !== true));
  ok("a credit whose blob sha MOVED is expired", files["lib/a.mjs"].verified === false);
  ok("a credit whose bytes are unchanged survives", files["lib/b.mjs"] === undefined);

  // The R7 shape, end to end: without the expiry, `verified` would still be true after the edit
  // and a `move → done` would pass route (b) on a green describing code that no longer exists.
  const after = applyTurn(state, { patch: [], action: { continue: true } }, { files });
  ok("through applyTurn the credit is gone, and the stale hash with it",
    after.state.files["lib/a.mjs"].verified === false && after.state.files["lib/a.mjs"].hash === undefined);
  ok("and the untouched credit is still standing", after.state.files["lib/b.mjs"].verified === true);
}
{
  const gone = tier1Files(
    { files: { "lib/x.mjs": { touched: true, verified: true, hash: "S" } } },
    CWD, { gitTouched: () => [], hashPaths: (p) => new Map(p.map(x => [x, null])) },
  );
  ok("a credited file that no longer exists loses its credit too", gone["lib/x.mjs"]?.verified === false);
}
{
  const merged = mergeFiles({ "a": { touched: true }, "b": { verified: false } }, { "a": { verified: true, hash: "S" } });
  ok("gate facts layer over tier-1 facts without erasing them",
    merged.a.touched === true && merged.a.verified === true && merged.b.verified === false);
}

// ── 3. the NEEDS_GATE cure ────────────────────────────────────────────────────────────────────
console.log("\n3. the NEEDS_GATE cure: ONE gate run, re-entered with gate_attempted");
{
  const state = emptyState(6969, "claude:trantor");
  state.in_flight = [{ id: "x1", text: "the wiring", paths: ["lib/state/driver.mjs"] }];
  const greenGate = {
    verify: { tested: true, cmd: "node test/run.mjs --only state", exit: 0 },
    files: { "lib/state/driver.mjs": { touched: true, verified: true, hash: "SHA_NEW" } },
    coverage: "scoped:test/state", cmd: "node test/run.mjs --only state", exit: 0, ms: 10, tail: "",
    memo: { hash: "H", verify: { tested: true }, files: {}, coverage: "scoped:test/state", cmd: "c", exit: 0, ts: 1 },
  };
  const r = rig({
    state, gate: greenGate,
    cliTurns: { patch: [{ move: { id: "x1", from: "in_flight", to: "done" } }], action: { done: true } },
  });
  const out = await runStep({
    seat: "claude:trantor", card: 6969, project: "trantor", cwd: CWD,
    preamble: "PRE", observation: "", now: 7, deps: r.deps,
  });
  ok("a green gate cures the rejection and the move lands", out.ok === true, out.message);
  ok("the gate ran exactly ONCE", r.seen.gates === 1);
  ok("applyTurn was entered twice — once bare, once with the evidence", r.seen.applyCtx.length === 2);
  ok("the first call had no gate_attempted", r.seen.applyCtx[0].gate_attempted === undefined);
  ok("the second call carries gate_attempted, which is what splits the two codes",
    r.seen.applyCtx[1].gate_attempted && r.seen.applyCtx[1].gate_attempted.exit === 0);
  ok("the memo lands through the single apply point (ctx.gate), never as a side effect",
    r.seen.applyCtx[1].gate !== undefined);
  ok("the run row records the paths the gate actually credited",
    r.seen.appended.some(a => Array.isArray(a.row.verified_paths) && a.row.verified_paths.includes("lib/state/driver.mjs")));
}
{
  const state = emptyState(6969, "claude:trantor");
  state.in_flight = [{ id: "x1", text: "the wiring", paths: ["lib/state/driver.mjs"] }];
  const redGate = {
    verify: { tested: false, cmd: "node test/run.mjs --only state", exit: 1 },
    files: { "lib/state/driver.mjs": { touched: true, verified: false } },
    coverage: "scoped:test/state", cmd: "node test/run.mjs --only state", exit: 1, ms: 10,
    tail: "  FAIL  the credit is expired", memo: { hash: "H", verify: { tested: false }, files: {}, cmd: "c", exit: 1, ts: 1 },
  };
  const r = rig({
    state, gate: redGate,
    cliTurns: { patch: [{ move: { id: "x1", from: "in_flight", to: "done" } }], action: { done: true } },
  });
  const out = await runStep({
    seat: "claude:trantor", card: 6969, project: "trantor", cwd: CWD,
    preamble: "PRE", observation: "", now: 7, deps: r.deps,
  });
  ok("a RED gate rejects with UNVERIFIED_DONE, never a second NEEDS_GATE", out.code === ERR.UNVERIFIED_DONE, out.code);
  ok("the gate still ran only once — the retry is bounded by construction", r.seen.gates === 1);
  ok("the seat's next observation opens with the actual failing assertion",
    out.observation.includes("FAIL  the credit is expired"), out.observation);
  ok("and a red gate commits nothing", r.seen.commits.length === 0);
}

// ── 4. a rejected patch stops at step one ─────────────────────────────────────────────────────
console.log("\n4. a rejected patch stops at step one — nothing committed, promoted or executed");
{
  const r = rig({ cliTurns: { patch: [{ set: { field: "verify", value: { tested: true } } }], action: { continue: true } } });
  const out = await runStep({
    seat: "claude:trantor", card: 6969, project: "trantor", cwd: CWD,
    preamble: "PRE", observation: "obs", now: 3, deps: r.deps,
  });
  ok("the write-matrix rejection is returned", out.code === ERR.READONLY_FIELD, out.code);
  ok("nothing was committed", r.seen.commits.length === 0);
  ok("nothing was promoted", r.seen.promotes.length === 0);
  ok("nothing was executed", r.seen.executed.length === 0);
  ok("the trace stops before commit", !out.trace.includes("commit") && !out.trace.includes("promote"));
  ok("the rejection becomes the next observation, written for a model to act on",
    out.observation.includes("READONLY_FIELD") && out.observation.length > 40);
  ok("a MALFORMED rejection earns exactly one retry (§7.3's ladder)",
    out.trace.filter(t => t === "cli").length === 2, out.trace.join(" "));
  ok("the retry's prompt carries the rejection as its observation, and the preamble is unmoved",
    r.seen.prompts[1].observation.includes("READONLY_FIELD") && r.seen.prompts[1].preamble === "PRE");
  ok("the patch ledger records the first code AND the retry's, separately (§7.3 counts after one retry)",
    r.seen.appended.some(a => a.row.code === ERR.READONLY_FIELD && a.row.retry_code === ERR.READONLY_FIELD));
}
{
  // An EVIDENCE rejection is not retried in-turn: the grammar was right and the CODE was wrong, so
  // the seat needs a whole step to fix it, not a second sampling of the same prompt.
  const state = emptyState(6969, "claude:trantor");
  state.in_flight = [{ id: "x1", text: "t", paths: ["lib/a.mjs"] }];
  const r = rig({
    state,
    gate: { verify: { tested: false, cmd: "c", exit: 1 }, files: {}, coverage: "project", cmd: "c", exit: 1, ms: 1, tail: "boom", memo: {} },
    cliTurns: { patch: [{ move: { id: "x1", from: "in_flight", to: "done" } }], action: { done: true } },
  });
  const out = await runStep({ seat: "claude:trantor", card: 6969, project: "trantor", cwd: CWD, preamble: "P", now: 1, deps: r.deps });
  ok("an evidence rejection re-runs the CLI zero extra times", out.trace.filter(t => t === "cli").length === 1);
  ok("and it is recorded with no retry_code, so the budget never counts it",
    r.seen.appended.some(a => a.row.code === ERR.UNVERIFIED_DONE && !("retry_code" in a.row)));
}
{
  // The loudest malformed output there is: an envelope with no structured result at all.
  const r = rig({});
  r.deps.callCli = async () => ({ exit: 0, stdout: "I had a think about it and decided not to." });
  const out = await runStep({ seat: "claude:trantor", card: 6969, project: "trantor", cwd: CWD, preamble: "P", now: 1, deps: r.deps });
  ok("prose where a TurnResult should be is a SCHEMA rejection, never a silently empty patch", out.code === ERR.SCHEMA);
  ok("and it commits nothing", r.seen.commits.length === 0);
}

// ── 5. STALE, and the breaker ─────────────────────────────────────────────────────────────────
console.log("\n5. STALE: re-read, re-apply ONCE on fresh state, then patch_failed");
{
  const r = rig({
    cliTurns: { patch: [{ set: { field: "task", value: "P6" } }], action: { continue: true } },
    commitResults: [{ ok: false, code: STALE, at: "rev", rev: 9, message: "state moved under this turn" }, { ok: true, rev: 2, path: "/x" }],
  });
  const out = await runStep({ seat: "claude:trantor", card: 6969, project: "trantor", cwd: CWD, preamble: "P", now: 1, deps: r.deps });
  ok("the cure re-reads and re-applies, then commits", out.ok === true, out.message);
  ok("the trace names the cure: stale → readState → applyTurn → commit",
    out.trace.join(" ").includes("commit stale readState applyTurn commit"), out.trace.join(" "));
  ok("exactly two reads — one retry, not a loop", r.reads() === 2);
}
{
  const r = rig({
    cliTurns: { patch: [{ set: { field: "task", value: "P6" } }], action: { continue: true } },
    commitResults: [
      { ok: false, code: STALE, at: "rev", rev: 9, message: "moved" },
      { ok: false, code: STALE, at: "rev", rev: 10, message: "moved again" },
    ],
  });
  const out = await runStep({ seat: "claude:trantor", card: 6969, project: "trantor", cwd: CWD, preamble: "P", now: 1, deps: r.deps });
  ok("a second STALE is recorded as patch_failed, not retried forever", out.code === "patch_failed");
  ok("nothing is promoted on a patch_failed", r.seen.promotes.length === 0);
  ok("and the run row carries it so the bench can see the turn happened",
    r.seen.appended.some(a => a.row.rejected && a.row.rejected.code === "patch_failed"));
}

console.log("\n   the §7.3 breaker counts malformed output and NOT a red gate");
{
  const malformed = Array.from({ length: BREAKER_WINDOW }, () => ({ seat: "claude:trantor", code: ERR.SCHEMA }));
  const v = breakerVerdict(malformed, "claude:trantor");
  ok("a claude seat is held to the enforced budget", v.class === "enforced" && v.budget === 0.02);
  ok("20 malformed turns trip it", v.tripped === true, v.message);

  const evidence = Array.from({ length: BREAKER_WINDOW }, () => ({ seat: "claude:trantor", code: ERR.UNVERIFIED_DONE }));
  ok("20 red-gate rejections do NOT — that is the healthiest seat there is, not a broken one",
    breakerVerdict(evidence, "claude:trantor").tripped === false);

  const recovered = Array.from({ length: BREAKER_WINDOW }, () => ({ seat: "claude:trantor", code: ERR.SCHEMA, retry_code: null }));
  ok("a patch that failed once and passed on the retry is not an invalid patch",
    breakerVerdict(recovered, "claude:trantor").tripped === false);

  ok("a partial window cannot trip it — a 100% rate over one turn is not a rolling rate",
    breakerVerdict([{ seat: "claude:trantor", code: ERR.SCHEMA }], "claude:trantor").tripped === false);
  ok("only the last 20 count",
    breakerVerdict([...Array.from({ length: 40 }, () => ({ seat: "claude:trantor", code: ERR.SCHEMA })),
      ...Array.from({ length: BREAKER_WINDOW }, () => ({ seat: "claude:trantor", code: null }))],
    "claude:trantor").tripped === false);
}

// ── 6. the recorder: the rows the bench reads ─────────────────────────────────────────────────
console.log("\n6. the run recorder writes what bin/state-bench.mjs --run reads");
{
  const rows = [];
  const row = recordStep({ appendJsonl: (p, r) => rows.push({ p, r }) }, "trantor", 6969, {
    turn: 4, rev: 11, by: "claude:trantor", ts: 5, exit: 0,
    cost: { cost_usd: 0.02, input: 12, output: 3, cache_read: 800, cache_creation: 0 },
    action: { continue: true }, verify: { cmd: "suite", exit: 0, tested: true },
    verified_paths: ["lib/state/driver.mjs"], rejected: null, cut: false, disturbed: false,
  });
  const FIELDS = ["turn", "rev", "by", "ts", "cost_usd", "input", "output", "cache_read", "cache_creation", "action", "verify", "verified_paths", "rejected"];
  ok(`every field gate 3-6 reads is present: ${FIELDS.join(", ")}`, FIELDS.every(f => f in row), JSON.stringify(row));
  ok("it lands under ~/.agent-bus/state/runs/<project>-<card>.jsonl", rows[0].p.endsWith("state/runs/trantor-6969.jsonl"));
  ok("cut and disturbed are absent unless true — the bench reads their presence", !("cut" in row) && !("disturbed" in row));
  const cutRow = recordStep({ appendJsonl: () => {} }, "trantor", 1, { turn: 1, rev: 1, by: "s", ts: 1, exit: 0, cost: null, action: null, verify: null, verified_paths: [], rejected: null, cut: true, disturbed: true });
  ok("and present when they are", cutRow.cut === true && cutRow.disturbed === true);
  ok("an unpriced envelope leaves cost_usd NULL, never 0 — a 0 flatters the ≥5× gate", cutRow.cost_usd === null);
}

// ── 7. the envelope decoder ───────────────────────────────────────────────────────────────────
console.log("\n7. parseEnvelope is total, and an unknown is never a pass");
{
  const good = parseEnvelope(ENV({ patch: [], action: { done: true } }));
  ok("a structured result is taken as-is", good.turn && good.turn.action.done === true);
  ok("the cost struct comes off the same envelope", good.cost.cache_read === 900 && good.cost.cost_usd === 0.01);
  const asString = parseEnvelope(JSON.stringify({ result: JSON.stringify({ patch: [], action: { ask: "?" } }), usage: {} }));
  ok("a JSON-STRING result is parsed too — releases differ", asString.turn && asString.turn.action.ask === "?");
  ok("prose is not a turn", parseEnvelope("just some text").turn === null);
  ok("empty stdout is not a turn", parseEnvelope("").turn === null && parseEnvelope("").error.length > 10);
  ok("neither is an error envelope", parseEnvelope(JSON.stringify({ is_error: true, subtype: "error_max_turns", usage: {} })).turn === null);
  ok("a leading log line before the JSON does not defeat it",
    parseEnvelope(`starting…\n${ENV({ patch: [], action: { continue: true } })}`).turn !== null);
  for (const junk of [null, undefined, 42, "{", "[]"]) {
    ok(`garbage (${JSON.stringify(junk)}) returns a reason, never a throw`, parseEnvelope(junk).turn === null);
  }
}

console.log("\n   a rejection reads as instructions, not as a log line");
ok("it names the code, the place, and the fix", rejectionObservation({ code: "CAP", at: "add:x", message: "id too long" }).includes("CAP"));
ok("a red gate's tail rides with it", rejectionObservation({ code: "UNVERIFIED_DONE", at: "move:x", message: "m", gate: { cmd: "c", exit: 1, tail: "assert failed" } }).includes("assert failed"));
ok("and nothing is an empty string by accident", rejectionObservation(null) === "");

console.log("\n   the card log is decoded at the boundary, not in the runner");
{
  const rows = [{ id: 6969, title: "P6 — the runner wiring", status: "doing", notes: [
    "an old record: a bare string",
    { by: "MacBook-Pro-M1:trantor", text: "the order is not a suggestion" },
    { by: "seat", note: "an older field name" },
    null,
  ] }];
  const tail = renderCardTail(rows, 6969);
  ok("the header names the card, its title and its status", tail.startsWith("#6969 P6 — the runner wiring · doing"));
  ok("a bare-string note survives", tail.includes("an old record: a bare string"));
  ok("a {by,text} note is attributed", tail.includes("MacBook-Pro-M1:trantor: the order is not a suggestion"));
  ok("an older {by,note} record is not dropped", tail.includes("seat: an older field name"));
  ok("a null row does not become a blank line", !tail.includes("\n\n"));
  ok("a card that is not on the board is \"\", never a throw", renderCardTail(rows, 1) === "");
  for (const junk of [null, undefined, 42, "rows", {}]) {
    ok(`garbage rows (${JSON.stringify(junk)}) return "" rather than throwing`, renderCardTail(junk, 1) === "");
  }
  ok("the tail carries no STATE_DELIM, which would forge the prefix boundary", !tail.includes(STATE_DELIM));
}

console.log("\n   and the window line the operator reads instead of a JSON blob (§4.6)");
ok("it names the op count and the action", describeTurn({ patch: [1, 2], action: { done: true } }) === "2 op(s), action done");
ok("an actionless turn says so rather than printing undefined", describeTurn({ patch: [], action: null }) === "0 op(s), action none");
ok("and nothing is a TurnResult by accident", describeTurn(null) === "no TurnResult");

done();

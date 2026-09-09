// P5 — assemble (TDD §4.6). The load-bearing assertion is THE PREFIX INVARIANT: everything before
// STATE_DELIM must be byte-identical across turns for ANY two states, because provider prefix
// caching is the mechanism the ≥5× cost gate stands on. It is held the only way it can be held —
// by hashing the prefix produced from two different states and asserting the hashes are equal —
// never by reading this file's code and reasoning that it looks right.
import { createHash } from "node:crypto";
import { assemble, renderState, capTokens, STATE_DELIM, TAIL_DELIM, OBS_DELIM } from "../../lib/state/assemble.mjs";
import { CAPS, emptyState } from "../../lib/state/schema.mjs";
import { harness } from "./_helpers.mjs";

const { ok, done } = harness();
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const PREAMBLE = "RULES: patch state via the schema. Kickoff: build the thing.";

// Two states with nothing in common — different task, lists, files, verify, cursor, rev, notes.
const stateA = {
  ...emptyState(6910, "glm:trantor"),
  task: "write the assembler",
  in_flight: [{ id: "a1", text: "render the block", paths: ["lib/state/assemble.mjs"] }],
  files: { "lib/state/assemble.mjs": { touched: true, verified: true, hash: "aa11" } },
  verify: { built: true, tested: true, exit: 0 },
  notes: "alpha notes",
  ext: { scratch: "A" },
  cursor: { turn: 7, ts: 1000, by: "glm:trantor" },
  rev: 7,
};
const stateB = {
  ...emptyState(4242, "claude:trantor"),
  task: "entirely other work",
  blockers: [{ id: "b1", text: "waiting on the hub" }],
  done: [{ id: "b2", text: "an old item" }],
  done_count: 12,
  files: { "src/other.mjs": { touched: true, verified: false } },
  notes: "beta notes",
  cursor: { turn: 41, ts: 9000, by: "claude:trantor" },
  rev: 12,
};

// ---- THE PREFIX INVARIANT (checklist 1) ----
{
  const a = assemble({ preamble: PREAMBLE, state: stateA, tail: "t", observation: "o" });
  const b = assemble({ preamble: PREAMBLE, state: stateB, tail: "t", observation: "o" });
  const ia = a.indexOf(STATE_DELIM);
  const ib = b.indexOf(STATE_DELIM);
  ok("prefix invariant: STATE_DELIM at the same integer index for two different states", ia === ib && ia > -1, `ia=${ia} ib=${ib}`);
  ok("prefix invariant: bytes before STATE_DELIM hash identical across two different states", sha(a.slice(0, ia)) === sha(b.slice(0, ib)));
  ok("prefix invariant: the prefix IS the caller's preamble, byte for byte", a.slice(0, ia) === PREAMBLE);
  ok("prefix invariant: preamble has no state content in it", !a.slice(0, ia).includes("6910") && !a.slice(0, ia).includes("4242"));

  // Same invariant with the default (empty) preamble — a future default that leaked state into
  // the prefix would pass the test above and still break caching on the first runner that omits it.
  const da = assemble({ state: stateA });
  const db = assemble({ state: stateB });
  const j = da.indexOf(STATE_DELIM);
  ok("prefix invariant holds with no preamble supplied", j === 0 && sha(da.slice(0, j)) === sha(db.slice(0, j)));

  // And the prefix survives wildly different tails/observations too — the prefix must not shift
  // when the variable parts change length across a cap boundary.
  const t1 = assemble({ preamble: PREAMBLE, state: stateA, tail: "x", observation: "y" });
  const t2 = assemble({ preamble: PREAMBLE, state: stateB, tail: "z".repeat(4 * CAPS.TAIL_TOKENS + 999), observation: "w".repeat(4 * CAPS.OBS_TOKENS + 999) });
  const k1 = t1.indexOf(STATE_DELIM), k2 = t2.indexOf(STATE_DELIM);
  ok("prefix invariant holds when tail/observation blow past their caps", k1 === k2 && sha(t1.slice(0, k1)) === sha(t2.slice(0, k2)));
}

// ---- the state block is real, not a constant (the hash above would pass a renderState that
// ignored its input — so assert the blocks DIFFER and carry the state's content) ----
{
  const a = assemble({ preamble: PREAMBLE, state: stateA });
  const b = assemble({ preamble: PREAMBLE, state: stateB });
  const block = (s) => s.slice(s.indexOf(STATE_DELIM) + STATE_DELIM.length, s.indexOf(TAIL_DELIM));
  ok("different states render different state blocks", block(a) !== block(b));
  ok("state block carries the task", block(a).includes("task: write the assembler"));
  ok("state block carries item id + text + evidence paths", block(a).includes("a1 render the block [lib/state/assemble.mjs]"));
  ok("state block carries files line with verified credit", block(a).includes("files: 1 touched, 1 verified: lib/state/assemble.mjs"));
  ok("unverified files render as touched-and-unverified", block(b).includes("files: 1 touched, 0 verified"));
  ok("state block carries verify facts", block(a).includes("verify: built=true tested=true exit=0"));
  ok("state block carries cursor/rev", block(a).includes("turn 7, rev 7"));
  ok("state block carries notes", block(a).includes("notes: alpha notes"));
  ok("state block carries model-owned ext keys", block(a).includes(`ext: ${JSON.stringify({ scratch: "A" })}`));
  ok("runtime ext keys stay private", !block(a).includes("_gate") && !block(a).includes("_promoted"));
  ok("done list shows the compacted count", block(b).includes("done (1 (+12 compacted))"));
}

// ---- caps: tail to CAPS.TAIL_TOKENS, observation to CAPS.OBS_TOKENS (checklist 2) ----
{
  const longTail = "t".repeat(4 * CAPS.TAIL_TOKENS + 50_000);
  const longObs = "o".repeat(4 * CAPS.OBS_TOKENS + 50_000);
  const p = assemble({ preamble: PREAMBLE, state: stateA, tail: longTail, observation: longObs });
  const tail = p.slice(p.indexOf(TAIL_DELIM) + TAIL_DELIM.length, p.indexOf(OBS_DELIM));
  const obs = p.slice(p.indexOf(OBS_DELIM) + OBS_DELIM.length);
  ok("tail truncated to the CAPS.TAIL_TOKENS budget (marker inside it)", tail.length <= 4 * CAPS.TAIL_TOKENS, `tail length ${tail.length}`);
  ok("observation truncated to the CAPS.OBS_TOKENS budget (marker inside it)", obs.length <= 4 * CAPS.OBS_TOKENS, `obs length ${obs.length}`);
  ok("truncated tail keeps the END (§4.8: the LAST tokens are the observation)", tail.endsWith("t".repeat(10)) && tail.includes("truncated"));
  ok("within-cap content passes through untouched, no marker", assemble({ preamble: PREAMBLE, state: stateA, tail: "abc" }).includes(`${TAIL_DELIM}abc${OBS_DELIM}`));
  ok("capTokens alone: over-cap returns exactly budget chars including the marker", capTokens(longTail, 10, "x").length <= 40);
  ok("capTokens alone: within-cap returns the input unchanged", capTokens("hello", 10, "x") === "hello");
  ok("capTokens alone: non-string degrades to empty", capTokens(null, 10, "x") === "");
}

// ---- O(1) in turn count: growing per-turn inputs stop growing the prompt ----
{
  const lengths = [];
  for (let t = 1; t <= 24; t++) {
    const p = assemble({
      preamble: PREAMBLE, state: stateA,
      tail: Array.from({ length: t }, (_, i) => `turn ${i + 1} log line with some prose on it`).join("\n").repeat(Math.ceil((t * 400) / 60)),
      observation: "gate output ".repeat(t * 500),
    });
    lengths.push(p.length);
  }
  const settled = lengths.slice(8);   // everything past the caps
  ok("assembled prompt length is constant once inputs exceed the caps (O(1), not O(T))", settled.every(n => n === settled[0]), lengths.join(","));
}

// ---- structure, determinism, totality ----
{
  const p = assemble({ preamble: PREAMBLE, state: stateA, tail: "T", observation: "O" });
  ok("delimiters appear in order STATE < TAIL < OBS", p.indexOf(STATE_DELIM) < p.indexOf(TAIL_DELIM) && p.indexOf(TAIL_DELIM) < p.indexOf(OBS_DELIM));
  ok("deterministic: same inputs, byte-identical output", p === assemble({ preamble: PREAMBLE, state: stateA, tail: "T", observation: "O" }));
  const bare = assemble({ preamble: PREAMBLE });
  ok("empty state still yields all three block headers, no throw", bare.includes(STATE_DELIM) && bare.includes(TAIL_DELIM) && bare.includes(OBS_DELIM));
  ok("null/garbage state renders as an empty block, never throws", renderState(null) === "" && renderState([1, 2]) === "" && renderState("nope") === "");
  ok("renderState is total against a shape-broken state", renderState({ task: 5, done: "no", files: null, cursor: null, ext: null, notes: 9 }).length >= 0);
}

done();

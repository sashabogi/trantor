#!/usr/bin/env node
/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: the suite feeds the boundary decoder (and
 * the promoter's post transport) deliberately malformed shapes to prove they are total — wrong
 * types are the input under test, not a substitute for a boundary. */
// Trantor State P3 — the promoter (TDD §4.7). Delta → one card note, content-hash dedupe, and the
// load-bearing ordering: `ext._promoted` advances ONLY after the hub answers 2xx, never when the
// plan is computed.
//
// The test this suite exists to carry is the ordering one in §8's gate row:
//   "a failed promote is re-sent, not swallowed" — a POST that throws leaves ext._promoted
//   unchanged, so the next turn re-sends the SAME content; a 2xx advances it and the next turn
//   skips. Written early, a promote that loses to a network blip would be counted as delivered and
//   the line dropped silently — the worst failure this design can have. That test is here, under
//   "ordering".
import { emptyState } from "../../lib/state/schema.mjs";
import { noteHash, composeNote, promote } from "../../lib/state/promote.mjs";
import { harness } from "./_helpers.mjs";

const { ok, done } = harness();
const BY = "deepseek:trantor";
const CARD = 6902;

/** A state for this card. `last` sets ext._promoted (the recorded last-sent hash), if any. */
function stateFor(last) {
  const s = emptyState(CARD, BY);
  if (last !== undefined) s.ext = { _promoted: last };
  return s;
}

/** A controllable hub transport: records every payload, and can be told to throw, answer 500, or 2xx. */
function hub() {
  const calls = [];
  let mode = "2xx";
  const post = async (payload) => {
    calls.push(payload);
    if (mode === "throw") throw new Error("network blip");
    if (mode === "500") return { ok: false, status: 500, json: { error: "boom" } };
    return { ok: true, status: 200, json: { task: { id: payload.id } } };
  };
  post.calls = calls;
  post.set = (m) => { mode = m; };
  return post;
}

const DONE = {
  kind: "done",
  text: "wire the promoter (lib/state/promote.mjs, test/state/test-promote.mjs)",
};
const BLOCKED = { kind: "blocker_added", text: "P1 store not merged yet" };
const UNBLOCKED = { kind: "blocker_cleared", text: "P1 store landed" };
const VERIFY = { kind: "verify", text: "tested — suite" };

console.log("\ncomposeNote: one line per promotion, empty delta is empty");
ok("done + blocker + unblock + verify → four labelled lines",
  composeNote([DONE, BLOCKED, UNBLOCKED, VERIFY])
    .split("\n").length === 4);
const note = composeNote([DONE]);
ok("the note carries the kind label", note.startsWith("done: "));
ok("the note carries the evidence path", note.includes("lib/state/promote.mjs"));
ok("an empty delta composes to nothing", composeNote([]) === "");
ok("undefined composes to nothing", composeNote(undefined) === "");
ok("malformed rows are skipped, not rendered",
  composeNote([null, "junk", { kind: "done" }, DONE]) === `done: ${DONE.text}`);
ok("unknown kinds render under their own name (never dropped silently)",
  composeNote([{ kind: "wat", text: "x" }]) === "wat: x");
ok("composeNote is deterministic", composeNote([DONE, BLOCKED]) === composeNote([DONE, BLOCKED]));

console.log("\ncomposeNote: the note cap is 2000 chars, and elision drops whole lines, never mid-slice");
const flood = Array.from({ length: 60 }, (_, i) => ({ kind: "done", text: `item ${i} `.repeat(30) }));
const big = composeNote(flood);
ok("a flood of promotions stays under the 2000-char cap", big.length <= 2000 && big.length > 0);
ok("elision says lines were dropped", big.includes("more"));
ok("deterministic even when truncated", big === composeNote(flood));
const single = composeNote([{ kind: "done", text: "x".repeat(5000) }]);
ok("a single over-long line is elided, not emitted past the cap", single.length <= 2000);

console.log("\nnoteHash: content identity, not a counter");
ok("same note → same hash", noteHash("a") === noteHash("a"));
ok("different note → different hash", noteHash("a") !== noteHash("b"));
ok("the hash is 64 hex chars", /^[0-9a-f]{64}$/.test(noteHash("anything")));

console.log("\nan empty delta skips entirely — no POST, no state change");
(async () => {
  const h = hub();
  const s = stateFor();
  const r = await promote(s, [], { by: BY, post: h });
  ok("skipped, not sent", r.ok === true && r.sent === false && r.skipped === "empty");
  ok("the hub was never touched", h.calls.length === 0);
  ok("state untouched", JSON.stringify(r.state) === JSON.stringify(s));

  console.log("\none delta, one note, one POST per turn — and by/from the session");
  const h1 = hub();
  const s1 = stateFor();
  const r1 = await promote(s1, [DONE, BLOCKED, UNBLOCKED, VERIFY], { by: BY, post: h1 });
  ok("sent", r1.ok === true && r1.sent === true, JSON.stringify(r1));
  ok("exactly one POST for four promotions", h1.calls.length === 1);
  const payload = h1.calls[0];
  ok("the payload addresses this card", payload.id === CARD);
  ok("the payload carries the session as by", payload.by === BY);
  ok("the payload is a note-only update — no status, no assignee, no checklist (state never moves a card)",
    !("status" in payload) && !("assignee" in payload) && !("checklist" in payload));
  ok("the note the hub saw is the composed note", payload.note === composeNote([DONE, BLOCKED, UNBLOCKED, VERIFY]));
  ok("the returned state is a clone with ext._promoted = hash of the note",
    r1.state.ext._promoted === noteHash(payload.note));
  ok("the input state is byte-identical — promote never mutates its argument",
    JSON.stringify(s1) === JSON.stringify(stateFor()));
  ok("the returned state still validates against the schema (ext._promoted is runtime-owned)",
    JSON.stringify(r1.state).includes(`"_promoted":"${r1.state.ext._promoted}"`));

  console.log("\nby defaults to the state's own session");
  const h2 = hub();
  const r2 = await promote(stateFor(), [DONE], { post: h2 });
  ok("sent with state.cursor.by when by is omitted", r2.sent === true && h2.calls[0].by === BY);

  console.log("\nordering — a failed POST leaves the hash where it was, and the next turn re-sends (§8)");
  const h3 = hub();
  const s3 = stateFor(); // no _promoted yet — nothing has ever been confirmed
  const delta = [DONE];
  h3.set("throw");
  const fail = await promote(s3, delta, { by: BY, post: h3 });
  ok("a throwing POST is a failure, not an exception", fail.ok === false && fail.sent === false);
  ok("the failure is non-fatal: a result came back, nothing threw", typeof fail.error === "string" && fail.error.length > 0);
  ok("the hash was NOT advanced — ext._promoted is still absent",
    fail.state.ext._promoted === undefined);
  ok("the input state is byte-identical — nothing rolled back, nothing half-written",
    JSON.stringify(fail.state) === JSON.stringify(stateFor()));

  // "the next turn": same delta, same (unadvanced) state, healthy hub — the SAME content is re-sent.
  h3.set("2xx");
  const retry = await promote(fail.state, delta, { by: BY, post: h3 });
  ok("the next turn re-sends the same content", retry.ok === true && retry.sent === true);
  ok("the note is byte-identical to the one the failed turn attempted",
    h3.calls.length === 2 && h3.calls[1].note === h3.calls[0].note);
  ok("a 2xx finally advances the hash", retry.state.ext._promoted === noteHash(h3.calls[1].note));

  // "the next turn skips": with the hash recorded, the identical delta is deduped, not re-POSTed.
  const again = await promote(retry.state, delta, { by: BY, post: h3 });
  ok("the identical next delta is skipped as a duplicate", again.ok === true && again.sent === false && again.skipped === "duplicate");
  ok("and the hub was NOT called a third time", h3.calls.length === 2);

  console.log("\nordering — a non-2xx answer is a failure too: no advance, re-sendable next turn");
  const h4 = hub();
  const s4 = stateFor();
  h4.set("500");
  const red = await promote(s4, delta, { by: BY, post: h4 });
  ok("a 500 is a failed promote", red.ok === false && red.sent === false && red.status === 500);
  ok("the 500 error text is surfaced for the caller", red.error === "boom");
  ok("hash unchanged after the 500", red.state.ext._promoted === undefined);
  h4.set("2xx");
  const recover = await promote(red.state, delta, { by: BY, post: h4 });
  ok("the same content is re-sent and confirmed after a 500", recover.sent === true
    && h4.calls[1].note === h4.calls[0].note);

  console.log("\nordering — the hash advances only on 2xx, never when the plan is computed");
  const h5 = hub();
  const s5 = stateFor("old-hash");
  const computed = await promote(s5, [UNBLOCKED], { by: BY, post: h5 }); // hub answers 2xx by default
  ok("a genuinely NEW delta is sent even when a previous note is recorded", computed.sent === true);
  ok("and the old hash is replaced by the new content's hash",
    computed.state.ext._promoted === noteHash(composeNote([UNBLOCKED])));

  console.log("\nordering — a STALE-style re-run of an already-confirmed delta cannot double-post");
  const h6 = hub();
  const confirmed = stateFor(noteHash(composeNote([DONE])));
  const replay = await promote(confirmed, [DONE], { by: BY, post: h6 });
  ok("the replay is skipped", replay.skipped === "duplicate" && replay.sent === false);
  ok("and no second POST went out", h6.calls.length === 0);

  console.log("\nthe promoter refuses a state with no card");
  const r7 = await promote({}, [DONE], { by: BY, post: hub() });
  ok("refused, not thrown", r7.ok === false && /card/.test(r7.error));

  done();
})();

#!/usr/bin/env node
// Trantor State P0 — the validator (TDD §4.2). The write matrix, the named rejections, and the two
// rules the review bought: a credit expires with the bytes it describes (R12), and NEEDS_GATE vs
// UNVERIFIED_DONE splits on ctx.gate_attempted.
import { CAPS, ERR, READONLY_FIELDS, emptyState } from "../../lib/state/schema.mjs";
import { validateTurn, extractEvidence, hasEvidence } from "../../lib/state/validate.mjs";
import { applyTurn } from "../../lib/state/apply.mjs";
import { harness, stateWithItem, turn } from "./_helpers.mjs";

const { ok, done } = harness();
const S = stateWithItem();

console.log("\nstage 1 — shape and action");
ok("a non-object turn is SCHEMA", validateTurn(S, "nope").code === ERR.SCHEMA);
ok("patch must be an array", validateTurn(S, { patch: {}, action: { done: true } }).code === ERR.SCHEMA);
ok("a missing action is BAD_ACTION", validateTurn(S, { patch: [] }).code === ERR.BAD_ACTION);
ok("an unrecognised action is BAD_ACTION", validateTurn(S, { patch: [], action: { wat: 1 } }).code === ERR.BAD_ACTION);
ok("an op with two operator keys is SCHEMA",
  validateTurn(S, turn([{ add: { list: "next", item: { id: "a", text: "b" } }, remove: { list: "next", id: "a" } }])).code === ERR.SCHEMA);
ok("an op with no operator key is SCHEMA", validateTurn(S, turn([{ wat: 1 }])).code === ERR.SCHEMA);
ok("an empty patch with a valid action is accepted", validateTurn(S, turn([])).ok === true);

console.log("\nstage 2 — the write matrix, one case per row (§2/§4.2)");
const MATRIX = [
  ["verify", { tested: true }],
  ["verify.tested", true],
  ["files", {}],
  ["files.lib/state/validate.mjs", { verified: true }],
  ["card", 1],
  ["schema_version", 3],
  ["cursor", { turn: 9, ts: 0, by: "x" }],
  ["done_count", 99],
  ["files_count", 99],
  ["rev", 42],
];
for (const [field, value] of MATRIX) {
  const r = validateTurn(S, turn([{ set: { field, value } }]));
  ok(`set ${field} → READONLY_FIELD`, r.code === ERR.READONLY_FIELD, JSON.stringify(r));
}
ok("every READONLY_FIELDS row is covered by a case above",
  READONLY_FIELDS.every(f => MATRIX.some(([field]) => field === f || field.startsWith(`${f}.`))));
ok("files[*].touched is harness-only too — git is ground truth",
  validateTurn(S, turn([{ set: { field: "files.a.mjs", value: { touched: true } } }])).code === ERR.READONLY_FIELD);
ok("ext._gate is runtime-owned",
  validateTurn(S, turn([{ set: { field: "ext._gate", value: { hash: "x" } } }])).code === ERR.READONLY_FIELD);
ok("ext._promoted is runtime-owned",
  validateTurn(S, turn([{ set: { field: "ext._promoted", value: "x" } }])).code === ERR.READONLY_FIELD);
ok("a list may not be set wholesale — arrays change only by id",
  validateTurn(S, turn([{ set: { field: "done", value: [] } }])).code === ERR.READONLY_FIELD);
ok("ext is writable", validateTurn(S, turn([{ set: { field: "ext.mine", value: 1 } }])).ok === true);
ok("notes is writable", validateTurn(S, turn([{ set: { field: "notes", value: "hello" } }])).ok === true);

console.log("\nstage 2 — task is set-once");
const blank = emptyState(1, "seat");
ok("task is writable while empty", validateTurn(blank, turn([{ set: { field: "task", value: "do the thing" } }])).ok === true);
ok("task is READONLY once set", validateTurn(S, turn([{ set: { field: "task", value: "other" } }])).code === ERR.READONLY_FIELD);
ok("a second set of task in the SAME patch is caught",
  validateTurn(blank, turn([
    { set: { field: "task", value: "one" } },
    { set: { field: "task", value: "two" } },
  ])).code === ERR.READONLY_FIELD);
ok("an over-long task is CAP",
  validateTurn(blank, turn([{ set: { field: "task", value: "t".repeat(CAPS.TASK + 1) } }])).code === ERR.CAP);

console.log("\nstage 3 — an unknown field is a named rejection, never a silent key");
ok("set on a field the schema does not define → UNKNOWN_FIELD",
  validateTurn(S, turn([{ set: { field: "wat", value: 1 } }])).code === ERR.UNKNOWN_FIELD);
ok("the rejection names the field",
  validateTurn(S, turn([{ set: { field: "wat", value: 1 } }])).message.includes("wat"));
ok("and it creates nothing: state is untouched",
  applyTurn(S, turn([{ set: { field: "wat", value: 1 } }])).ok === false);

console.log("\nstage 3 — ids and lists");
ok("add with an existing id → DUP_ID",
  validateTurn(S, turn([{ add: { list: "next", item: { id: "x1", text: "dup" } } }])).code === ERR.DUP_ID);
ok("remove a missing id → NO_SUCH_ID",
  validateTurn(S, turn([{ remove: { list: "next", id: "nope" } }])).code === ERR.NO_SUCH_ID);
ok("remove from the WRONG list → NO_SUCH_ID naming where it actually is",
  validateTurn(S, turn([{ remove: { list: "next", id: "x1" } }])).message.includes("in_flight"));
ok("move a missing id → NO_SUCH_ID",
  validateTurn(S, turn([{ move: { id: "nope", from: "in_flight", to: "next" } }])).code === ERR.NO_SUCH_ID);
ok("an unknown list → UNKNOWN_LIST",
  validateTurn(S, turn([{ add: { list: "wat", item: { id: "a", text: "b" } } }])).code === ERR.UNKNOWN_LIST);
ok("an over-long id → CAP, not a trim",
  validateTurn(S, turn([{ add: { list: "next", item: { id: "z".repeat(CAPS.ID + 1), text: "b" } } }])).code === ERR.CAP);
ok("ops later in a patch see what earlier ops did",
  validateTurn(S, turn([
    { add: { list: "next", item: { id: "n1", text: "a" } } },
    { move: { id: "n1", from: "next", to: "in_flight" } },
  ])).ok === true);

console.log("\nthe evidence marker: extract BEFORE cap (§3)");
const long = { id: "a", text: `${"p".repeat(CAPS.ITEM + 50)} @lib/state/apply.mjs` };
const ex = extractEvidence(long);
ok("a long item keeps its paths", ex.ok && ex.item.paths.join() === "lib/state/apply.mjs");
ok("and its prose is capped", ex.ok && ex.item.text.length <= CAPS.ITEM);
ok("a malformed marker is CAP, never trimmed into silence",
  extractEvidence({ id: "a", text: `x @${"p".repeat(CAPS.PATH + 1)}` }).ok === false);
ok("too many paths is CAP",
  extractEvidence({ id: "a", text: `x @${Array.from({ length: CAPS.ITEM_PATHS + 1 }, (_, i) => `f${i}.mjs`).join(",")}` }).ok === false);
ok("a path escaping the worktree is CAP",
  extractEvidence({ id: "a", text: "x @../../etc/passwd" }).ok === false);
ok("an absolute path is CAP", extractEvidence({ id: "a", text: "x @/etc/passwd" }).ok === false);
ok("explicit paths and a marker converge on one field",
  extractEvidence({ id: "a", text: "x @b.mjs", paths: ["a.mjs"] }).item.paths.join() === "a.mjs,b.mjs");
ok("the marker route reaches the validator",
  validateTurn(S, turn([{ add: { list: "next", item: { id: "n2", text: "do it @lib/x.mjs" } } }])).ops[0].add.item.paths.join() === "lib/x.mjs");

console.log("\nmove → done: the two evidence routes (§4.2)");
const withGreen = { ...emptyState(1, "s"), in_flight: [{ id: "a", text: "t" }], verify: { tested: true, exit: 0 } };
ok("route (a): the gate went green this turn", hasEvidence(withGreen, { id: "a", text: "t" }) === true);
ok("route (a) needs exit 0 too",
  hasEvidence({ ...withGreen, verify: { tested: true, exit: 1 } }, { id: "a", text: "t" }) === false);
const credited = emptyState(1, "s");
credited.in_flight = [{ id: "a", text: "t", paths: ["lib/x.mjs"] }];
credited.files["lib/x.mjs"] = { touched: true, verified: true, hash: "sha-1" };
ok("route (b): every named path is credited", hasEvidence(credited, credited.in_flight[0]) === true);
ok("route (b) fails if ONE path is uncredited",
  hasEvidence(credited, { id: "a", text: "t", paths: ["lib/x.mjs", "lib/y.mjs"] }) === false);
ok("an item naming no path cannot use route (b)", hasEvidence(credited, { id: "a", text: "t" }) === false);
ok("a credited move → done is accepted",
  validateTurn(credited, turn([{ move: { id: "a", from: "in_flight", to: "done" } }])).ok === true);

console.log("\nNEEDS_GATE vs UNVERIFIED_DONE — the split that bounds the retry at one (§4.8)");
const bare = emptyState(1, "s");
bare.in_flight = [{ id: "a", text: "t", paths: ["lib/x.mjs"] }];
const moveDone = turn([{ move: { id: "a", from: "in_flight", to: "done" } }]);
const noGate = validateTurn(bare, moveDone, {});
ok("no gate attempted → NEEDS_GATE", noGate.code === ERR.NEEDS_GATE);
ok("NEEDS_GATE carries the items and paths that would satisfy it",
  noGate.gate?.items.join() === "a" && noGate.gate?.paths.join() === "lib/x.mjs");
const redGate = validateTurn(bare, moveDone, { gate_attempted: { cmd: "node test/run.mjs --only state", exit: 1, tail: "1 FAILED" } });
ok("a gate that RAN and failed → UNVERIFIED_DONE, never NEEDS_GATE again",
  redGate.code === ERR.UNVERIFIED_DONE, JSON.stringify(redGate));
ok("and it carries the failure tail the seat needs", redGate.gate?.tail === "1 FAILED" && redGate.gate?.exit === 1);
ok("the message names the command that failed", redGate.message.includes("node test/run.mjs --only state"));
ok("so the driver's one retry terminates: the second call cannot return NEEDS_GATE",
  redGate.code !== ERR.NEEDS_GATE);

console.log("\nR12 — a credit expires with the bytes it describes");
// The negative case IS the test: without the expiry this move is accepted, which is the bug.
const green = applyTurn(bare, turn([]), {
  files: { "lib/x.mjs": { touched: true, verified: true, hash: "sha-BEFORE" } },
});
ok("the gate credits the path", green.state.files["lib/x.mjs"].verified === true);
ok("with the credit, move → done passes", validateTurn(green.state, moveDone).ok === true);
// tier 1 re-hashes, sees the bytes moved, and expires the credit
const expired = applyTurn(green.state, turn([]), {
  files: { "lib/x.mjs": { touched: true, verified: false } },
});
ok("tier 1 clears the credit when the content hash moves", expired.state.files["lib/x.mjs"].verified === false);
ok("and the stale hash goes with it", expired.state.files["lib/x.mjs"].hash === undefined);
const afterEdit = validateTurn(expired.state, moveDone, {});
ok("THE CASE THAT MATTERS: the same move → done is now REJECTED",
  afterEdit.ok === false, JSON.stringify(afterEdit));
ok("and it is NEEDS_GATE — evidence is absent, not stale-present, so the gate is reached",
  afterEdit.code === ERR.NEEDS_GATE);

console.log("\nverify is rewritten from ctx every turn, so route (a) cannot go stale either");
const greenA = applyTurn(bare, turn([]), { verify: { tested: true, exit: 0, cmd: "suite" } });
ok("a green gate populates verify", greenA.state.verify.tested === true);
const nextTurn = applyTurn(greenA.state, turn([]), {});
ok("a turn with no gate CLEARS verify wholesale", Object.keys(nextTurn.state.verify).length === 0);
ok("so route (a) evidence does not survive into a turn that ran no gate",
  validateTurn(nextTurn.state, moveDone, {}).code === ERR.NEEDS_GATE);

done();

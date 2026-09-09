#!/usr/bin/env node
/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: the suite asserts the boundary decoder is total, which means feeding it values of the wrong type on purpose. */
// Trantor State P0 — the ordering invariant (TDD §4.1): validate before apply, apply before commit,
// commit before promote. A rejected patch leaves state BYTE-IDENTICAL and promotes nothing.
//
// This is the suite that makes the crash-safety argument checkable: if a rejection could leave a
// half-applied state behind, "a cut turn has never partially applied a patch" would be a hope.
import { ERR, emptyState } from "../../lib/state/schema.mjs";
import { applyTurn } from "../../lib/state/apply.mjs";
import { harness, stateWithItem, turn } from "./_helpers.mjs";

const { ok, done } = harness();

/** Every shape of rejection the pure core can produce, each as a patch that reaches it. */
const REJECTIONS = [
  ["SCHEMA (bad op)", turn([{ wat: 1 }])],
  ["BAD_ACTION", { patch: [], action: { nope: true } }],
  ["READONLY_FIELD", turn([{ set: { field: "verify", value: { tested: true } } }])],
  ["UNKNOWN_FIELD", turn([{ set: { field: "wat", value: 1 } }])],
  ["UNKNOWN_LIST", turn([{ add: { list: "wat", item: { id: "a", text: "b" } } }])],
  ["DUP_ID", turn([{ add: { list: "next", item: { id: "x1", text: "dup" } } }])],
  ["NO_SUCH_ID", turn([{ remove: { list: "next", id: "ghost" } }])],
  ["CAP", turn([{ add: { list: "next", item: { id: "z".repeat(99), text: "b" } } }])],
  ["NEEDS_GATE", turn([{ move: { id: "x1", from: "in_flight", to: "done" } }])],
];

console.log("\na rejected patch leaves state byte-identical and promotes nothing");
for (const [name, patch] of REJECTIONS) {
  const state = stateWithItem();
  const before = JSON.stringify(state);
  const r = applyTurn(state, patch, {});
  ok(`${name}: rejected`, r.ok === false, JSON.stringify(r));
  ok(`${name}: the input state is byte-identical afterwards`, JSON.stringify(state) === before);
  ok(`${name}: no state is returned to commit`, r.state === undefined);
  ok(`${name}: nothing is promoted`, r.promoted === undefined);
  ok(`${name}: the rejection names where it happened`, typeof r.at === "string" && r.at.length > 0);
  ok(`${name}: the message is written for a model to act on`, typeof r.message === "string" && r.message.length > 10);
}

console.log("\nUNVERIFIED_DONE takes the same path — a red gate is a rejection like any other");
const bare = { ...emptyState(1, "s"), in_flight: [{ id: "a", text: "t", paths: ["lib/x.mjs"] }] };
const beforeRed = JSON.stringify(bare);
const red = applyTurn(bare, turn([{ move: { id: "a", from: "in_flight", to: "done" } }]),
  { gate_attempted: { cmd: "suite", exit: 1, tail: "1 FAILED" } });
ok("rejected as UNVERIFIED_DONE", red.code === ERR.UNVERIFIED_DONE);
ok("state untouched", JSON.stringify(bare) === beforeRed);
ok("nothing promoted", red.promoted === undefined);
ok("and the seat gets the failure tail as its next observation", red.gate.tail === "1 FAILED");

console.log("\nrejection is total: the core never throws, whatever it is handed");
const GARBAGE = [undefined, null, 42, "string", [], { patch: null }, { patch: [null] }, { patch: [[]], action: { done: true } }];
let threw = 0;
for (const g of GARBAGE) {
  try {
    const r = applyTurn(stateWithItem(), g, {});
    if (r.ok !== false) threw++;
  } catch { threw++; }
}
ok(`every garbage input returns a rejection instead of throwing (${GARBAGE.length} shapes)`, threw === 0);

console.log("\nan ACCEPTED patch applies wholly, in order");
const credited = emptyState(1, "s");
credited.in_flight = [{ id: "a", text: "one", paths: ["lib/x.mjs"] }];
credited.files["lib/x.mjs"] = { touched: true, verified: true, hash: "sha" };
const before = JSON.stringify(credited);
const good = applyTurn(credited, turn([
  { add: { list: "next", item: { id: "b", text: "two" } } },
  { move: { id: "a", from: "in_flight", to: "done" } },
  { move: { id: "b", from: "next", to: "in_flight" } },
]), { now: 1, by: "seat" });
ok("accepted", good.ok === true, JSON.stringify(good));
ok("the INPUT state is still byte-identical — apply works on a clone", JSON.stringify(credited) === before);
ok("ops applied in order: a reached done", good.state.done.map(i => i.id).join() === "a");
ok("ops applied in order: b was added then moved", good.state.in_flight.map(i => i.id).join() === "b");
ok("and the intermediate list is empty again", good.state.next.length === 0);
ok("promotion is planned, not performed — the plan is data the promoter will send",
  Array.isArray(good.promoted) && good.promoted.length > 0);
ok("rev advanced exactly once for the whole patch", good.state.rev === credited.rev + 1);
ok("cursor advanced exactly once too", good.state.cursor.turn === credited.cursor.turn + 1);

console.log("\napplyTurn is a function of its arguments");
const s1 = stateWithItem();
const a = applyTurn(s1, turn([{ set: { field: "notes", value: "x" } }]), { now: 5, by: "seat" });
const b = applyTurn(s1, turn([{ set: { field: "notes", value: "x" } }]), { now: 5, by: "seat" });
ok("same state, same patch, same ctx → identical result", JSON.stringify(a) === JSON.stringify(b));
ok("no clock is read: ts comes from ctx alone", a.state.cursor.ts === 5);
const noCtx = applyTurn(s1, turn([]), {});
ok("and with no ctx.now the previous ts is kept, never Date.now()", noCtx.state.cursor.ts === s1.cursor.ts);

done();

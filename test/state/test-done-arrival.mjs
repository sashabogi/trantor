#!/usr/bin/env node
// Trantor State — the verified-done rule holds at EVERY door into `done` (#8068).
//
// Why this suite exists. §4.8's evidence rule was implemented inside the `move` op handler only.
// `add … list:"done"` never consulted hasEvidence, so a seat that finished an item in the same turn
// it did the work — the ordinary flow, and the one the grammar deliberately allows — landed it in
// `done` with no gate, no NEEDS_GATE and no UNVERIFIED_DONE. That is not theoretical: the first real
// Phase-2a run (card #6448, 2026-09-18) wrote the ops journal `set, add, add, add, add, add, set`,
// put four items into `done`, and recorded verify:{} and verified_paths:[]. Across all 15 state steps
// ever recorded at that point, not one carried evidence.
//
// The rule under test is arrival, not operator: however an item GETS to `done`, it needs evidence.
// The two ops must also stay indistinguishable in KIND of rejection, because the driver's one-retry
// cure (driver.mjs, §4.8) branches on the code — NEEDS_GATE when no gate has run, UNVERIFIED_DONE
// when one ran and failed, split on ctx.gate_attempted and nothing else.
import { ERR } from "../../lib/state/schema.mjs";
import { validateTurn } from "../../lib/state/validate.mjs";
import { harness, stateWithItem, turn } from "./_helpers.mjs";

const { ok, done } = harness();

const ITEM = { id: "x9", text: "split lib.rs", paths: ["desktop/src-tauri/src/lib.rs"] };
const addToDone = (item = ITEM) => turn([{ add: { list: "done", item } }]);
const GREEN = { verify: { tested: true, exit: 0 } };
const RED = { gate_attempted: { cmd: "cargo test", exit: 101, tail: "test lib::boundary ... FAILED" } };

console.log("\nthe bypass is closed — add into done is gated like move into done");
{
  const S = stateWithItem();
  const r = validateTurn(S, addToDone(), {});
  ok("add → done with no gate is REJECTED", r.ok === false, `got ok=${r.ok}`);
  ok("…and the code is NEEDS_GATE", r.code === ERR.NEEDS_GATE, `got ${r.code}`);
  ok("…the rejection names the op the seat actually wrote", r.at === "add:x9", `got ${r.at}`);
  ok("…and it carries what would satisfy it", r.gate?.items?.[0] === "x9" && r.gate?.paths?.length === 1,
    JSON.stringify(r.gate));
}

console.log("\nthe #6448 shape specifically — the exact patch that slipped through");
{
  // Four items added straight to done in one patch, no move, no prior gate. Every one must be refused,
  // and the FIRST refusal is what the seat sees: all-or-nothing, nothing half-applied.
  const S = stateWithItem();
  const four = ["split", "clippy", "rule8", "gate"].map((id, i) => ({
    add: { list: "done", item: { id, text: `step ${i}`, paths: ["desktop/src-tauri/src/lib.rs"] } },
  }));
  const r = validateTurn(S, turn(four), {});
  ok("the real #6448 patch shape is refused", r.ok === false && r.code === ERR.NEEDS_GATE,
    `ok=${r.ok} code=${r.code}`);
  ok("…refused at the FIRST item, not the last", r.at === "add:split", `got ${r.at}`);
}

console.log("\nthe NEEDS_GATE / UNVERIFIED_DONE split behaves identically on both doors");
{
  const S = stateWithItem();
  const viaAdd = validateTurn(S, addToDone(), RED);
  const withItem = stateWithItem();
  withItem.in_flight = [{ ...ITEM }];
  const viaMove = validateTurn(withItem, turn([{ move: { id: "x9", from: "in_flight", to: "done" } }]), RED);

  ok("a gate that RAN and failed is UNVERIFIED_DONE on the add path", viaAdd.code === ERR.UNVERIFIED_DONE, `got ${viaAdd.code}`);
  ok("…and the same on the move path", viaMove.code === ERR.UNVERIFIED_DONE, `got ${viaMove.code}`);
  ok("both doors agree on the code", viaAdd.code === viaMove.code);
  ok("the add path carries the failure tail back to the seat",
    viaAdd.gate?.exit === 101 && /FAILED/.test(viaAdd.gate?.tail || ""), JSON.stringify(viaAdd.gate));
  ok("…and it names the command that failed", viaAdd.gate?.cmd === "cargo test", `got ${viaAdd.gate?.cmd}`);
}

console.log("\nevidence still lets an item land — the rule is a gate, not a wall");
{
  const S = stateWithItem();
  ok("add → done passes when the gate went green this turn", validateTurn(S, addToDone(), GREEN).ok === true);

  // Route (b): every named path already credited. Same item, credit carried on state.
  const credited = stateWithItem();
  credited.files = { "desktop/src-tauri/src/lib.rs": { verified: true } };
  ok("add → done passes when every named path is credited", validateTurn(credited, addToDone(), {}).ok === true);

  // An item naming NO paths cannot ride route (b) — that is the #6969/R6 hole, and it must stay shut.
  const S2 = stateWithItem();
  const pathless = validateTurn(S2, addToDone({ id: "x9", text: "no paths named" }), {});
  ok("a pathless item still needs a green gate, never route (b)",
    pathless.ok === false && pathless.code === ERR.NEEDS_GATE, `ok=${pathless.ok} code=${pathless.code}`);
}

console.log("\nnothing else changed — the other lists take an add with no evidence at all");
for (const list of ["in_flight", "next", "blockers"]) {
  const S = stateWithItem();
  const r = validateTurn(S, turn([{ add: { list, item: { id: "y1", text: "still just work" } } }]), {});
  ok(`add → ${list} needs no evidence`, r.ok === true, `code=${r.code} at=${r.at}`);
}

console.log("\nreconstruction is the ONE exception, and a seat cannot claim it");
{
  const S = stateWithItem();
  ok("a derived rebuild may record what the handoff reported done",
    validateTurn(S, addToDone(), { reconstructing: true }).ok === true);
  ok("…but only when the HARNESS says so: a patch cannot write ctx (§3.0 write matrix)",
    validateTurn(S, addToDone(), {}).code === ERR.NEEDS_GATE);
  ok("a truthy-but-wrong value does not open the door",
    validateTurn(S, addToDone(), { reconstructing: "yes" }).code === ERR.NEEDS_GATE);
  // The credit half of the contract: reconstruction admits the ITEM, never the EVIDENCE. If this
  // ever passes with verified paths, a handoff would be laundering credit the gate never granted.
  const r = validateTurn(S, addToDone(), { reconstructing: true });
  ok("…and it grants no credit on the way in",
    r.ok === true && !Object.values(S.files || {}).some(f => f.verified === true));
}

done();

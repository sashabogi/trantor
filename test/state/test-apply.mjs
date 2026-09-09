#!/usr/bin/env node
// Trantor State P0 — apply, and the two property tests the PRD's Phase-0 exit gate names:
// no valid patch corrupts state, and arrays change only by id. 500 generated op sequences over a
// generated state, every result either re-validating against the schema or rejected — with NO
// third outcome, which is why NEEDS_GATE is asserted here to BE a rejection.
import { CAPS, ERR, EVIDENCE_CODES, MALFORMED_CODES, emptyState, stateError } from "../../lib/state/schema.mjs";
import { applyTurn, promotionPlan, allIds } from "../../lib/state/apply.mjs";
import { harness, stateWithItem, turn } from "./_helpers.mjs";

const { ok, done } = harness();

// Seeded PRNG: a property test that cannot be replayed is a rumour, not a test.
const SEED = Number(process.env.STATE_PROP_SEED || 20260908);
let seed = SEED;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (n) => Math.floor(rnd() * n);

const LISTS = ["done", "in_flight", "next", "blockers"];

function genState() {
  const s = emptyState(int(9999), "claude:trantor");
  if (rnd() < 0.8) s.task = "generated task";
  let n = 0;
  for (const list of LISTS) {
    for (let i = 0; i < int(4); i++) {
      const id = `g${n++}`;
      const item = { id, text: `item ${id}` };
      if (rnd() < 0.5) item.paths = [`lib/gen/${id}.mjs`];
      s[list].push(item);
    }
  }
  if (rnd() < 0.4) s.files["lib/gen/g0.mjs"] = { touched: true, verified: rnd() < 0.5, hash: "sha" };
  if (rnd() < 0.3) s.verify = { tested: rnd() < 0.5, exit: int(2) };
  if (rnd() < 0.2) s.ext.note = "x".repeat(int(200));
  return s;
}

// The generator is biased toward PLAUSIBLE ops — ids that exist, lists that exist — with a
// hostile minority. A generator that is hostile on every op rejects on the first one every time
// and never reaches the interesting states, which makes the accepted half of the property
// vacuous. `where` tracks which list each id is in so a `move` names its real source.
function genOp(state, where) {
  const ids = [...where.keys()];
  const hostile = rnd() < 0.2;
  const kind = pick(["set", "add", "remove", "move", "move"]);

  if (kind === "set") {
    const field = hostile ? pick(["verify", "rev", "files", "wat", "done", "cursor"]) : pick(["notes", "ext.k"]);
    return { set: { field, value: pick(["s", 1, { a: 1 }]) } };
  }
  if (kind === "add") {
    const id = hostile && rnd() < 0.5 ? "z".repeat(CAPS.ID + 1) : `n${int(99999)}`;
    const text = rnd() < 0.3 ? "t @lib/gen/g0.mjs" : "t";
    return { add: { list: hostile ? pick([...LISTS, "wat"]) : pick(LISTS), item: { id, text } } };
  }
  if (kind === "remove") {
    if (!ids.length || hostile) return { remove: { list: pick(LISTS), id: "missing" } };
    const id = pick(ids);
    return { remove: { list: where.get(id), id } };
  }
  if (!ids.length || hostile) return { move: { id: "missing", from: pick(LISTS), to: pick(LISTS) } };
  const id = pick(ids);
  // Weighted toward `done`, because move → done is where the evidence rules live.
  return { move: { id, from: where.get(id), to: rnd() < 0.5 ? "done" : pick(LISTS) } };
}

/** id → list, tracked forward so the generator can name a real source list. */
function whereOf(state) {
  const w = new Map();
  for (const l of LISTS) for (const it of state[l]) w.set(it.id, l);
  return w;
}

/** Mirror an op's effect on the id→list map, so later ops in the same sequence stay plausible. */
function trackOp(op, where) {
  if (op?.add?.item?.id && LISTS.includes(op.add.list)) where.set(op.add.item.id, op.add.list);
  else if (op?.remove?.id) where.delete(op.remove.id);
  else if (op?.move?.id && LISTS.includes(op.move.to) && where.has(op.move.id)) where.set(op.move.id, op.move.to);
}

function genSequence(state, max) {
  const where = whereOf(state);
  const ops = [];
  for (let i = 0; i < 1 + int(max); i++) {
    const op = genOp(state, where);
    trackOp(op, where);
    ops.push(op);
  }
  // A minority of sequences carry outright junk, so stage 1 stays exercised.
  if (rnd() < 0.1) ops.push(pick([{ wat: 1 }, {}, "string", null, { set: {} }]));
  return ops;
}

console.log("\nproperty: no valid patch corrupts state (500 generated sequences)");
let accepted = 0, rejected = 0, thirdOutcome = 0, corrupt = 0, needsGateSeen = 0, unknownCode = 0;
const ALL_CODES = new Set([...MALFORMED_CODES, ...EVIDENCE_CODES]);
for (let run = 0; run < 500; run++) {
  const state = genState();
  const before = JSON.stringify(state);
  const ops = genSequence(state, 4);
  const action = rnd() < 0.05 ? { wat: 1 } : pick([{ done: true }, { continue: true }, { ask: "?" }, { tool: "Bash", input: {} }]);
  const ctx = rnd() < 0.3 ? { gate_attempted: { cmd: "suite", exit: 1, tail: "boom" } } : {};
  const r = applyTurn(state, { patch: ops, action }, ctx);

  if (r.ok === true) {
    accepted++;
    if (stateError(r.state) !== "") { corrupt++; console.log(`    seed ${SEED} run ${run}: ${stateError(r.state)}`); }
  } else if (r.ok === false) {
    rejected++;
    if (r.code === ERR.NEEDS_GATE) { needsGateSeen++; if (r.ok !== false) thirdOutcome++; }
    if (!ALL_CODES.has(r.code)) { unknownCode++; console.log(`    run ${run}: unclassified code ${r.code}`); }
  } else {
    thirdOutcome++;
  }
  if (JSON.stringify(state) !== before) { corrupt++; console.log(`    run ${run}: applyTurn mutated its input`); }
}
ok(`every accepted patch re-validates against the schema (${accepted} accepted)`, corrupt === 0);
ok(`every result is accept or reject — no third outcome (${rejected} rejected)`, thirdOutcome === 0);
ok(`NEEDS_GATE is a REJECTION (ok:false), so §4.8 cannot weaken this property later (${needsGateSeen} seen)`,
  needsGateSeen > 0);
ok("every rejection code is one the §7.3 classifier knows", unknownCode === 0);
ok("the generator actually exercised both outcomes", accepted > 20 && rejected > 20);

console.log("\nproperty: arrays change only by id (500 generated sequences)");
let idDrift = 0, checked = 0;
for (let run = 0; run < 500; run++) {
  const state = genState();
  const ops = genSequence(state, 3);
  const r = applyTurn(state, { patch: ops, action: { continue: true } }, {});
  if (!r.ok) continue;
  checked++;
  const declared = new Set();
  for (const op of ops) {
    if (op?.add?.item?.id) declared.add(op.add.item.id);
    if (op?.remove?.id) declared.add(op.remove.id);
    if (op?.move?.id) declared.add(op.move.id);
  }
  const before = new Set(allIds(state));
  const after = new Set(allIds(r.state));
  // Compaction of `done` overflow can retire ids the ops never named, so a drop is only a
  // violation when nothing was compacted this turn.
  const compacted = r.state.done_count > state.done_count;
  for (const id of after) if (!before.has(id) && !declared.has(id)) idDrift++;
  if (!compacted) for (const id of before) if (!after.has(id) && !declared.has(id)) idDrift++;
}
ok(`the id multiset changes only by the ops' declared ids (${checked} accepted patches)`, idDrift === 0);

console.log("\nstage 4 — all-or-nothing");
const S = stateWithItem();
const partial = applyTurn(S, turn([
  { add: { list: "next", item: { id: "good", text: "fine" } } },
  { set: { field: "rev", value: 99 } },
]));
ok("one bad op aborts the whole patch", partial.ok === false && partial.code === ERR.READONLY_FIELD);
ok("and the good op did not land", applyTurn(S, turn([])).state.next.length === 0);

console.log("\nstage 5 — the runtime pass");
const r1 = applyTurn(S, turn([{ set: { field: "notes", value: "hello" } }]), { now: 1700000000000, by: "claude:trantor" });
ok("rev increments", r1.state.rev === S.rev + 1);
ok("cursor.turn increments", r1.state.cursor.turn === S.cursor.turn + 1);
ok("cursor.ts comes from ctx, not from the clock", r1.state.cursor.ts === 1700000000000);
ok("cursor.by comes from ctx", r1.state.cursor.by === "claude:trantor");
ok("the model's own field landed", r1.state.notes === "hello");
ok("ext._gate is written from ctx, through the single apply point",
  applyTurn(S, turn([]), { gate: { hash: "tree-sha", coverage: "scoped:test/state" } }).state.ext._gate.coverage === "scoped:test/state");
ok("ctx.files facts land", applyTurn(S, turn([]), { files: { "a.mjs": { touched: true } } }).state.files["a.mjs"].touched === true);
ok("verify is rewritten, not merged",
  applyTurn({ ...S, verify: { built: true } }, turn([]), { verify: { tested: true } }).state.verify.built === undefined);

console.log("\nthe promotion plan (§4.7)");
const credited = emptyState(1, "s");
credited.in_flight = [{ id: "a", text: "shipped the thing", paths: ["lib/x.mjs"] }];
credited.files["lib/x.mjs"] = { touched: true, verified: true, hash: "sha" };
const moved = applyTurn(credited, turn([{ move: { id: "a", from: "in_flight", to: "done" } }]), {});
ok("an item reaching done promotes", moved.promoted.some(p => p.kind === "done"));
ok("and the note carries its evidence", moved.promoted.find(p => p.kind === "done").text.includes("lib/x.mjs"));
const blocked = applyTurn(credited, turn([{ add: { list: "blockers", item: { id: "b1", text: "hub is down" } } }]), {});
ok("a new blocker promotes — a blocker nobody can see is the failure the bus exists to remove",
  blocked.promoted.some(p => p.kind === "blocker_added"));
ok("clearing a blocker promotes",
  applyTurn(blocked.state, turn([{ remove: { list: "blockers", id: "b1" } }]), {})
    .promoted.some(p => p.kind === "blocker_cleared"));
ok("in_flight churn promotes NOTHING (#6669's lesson)",
  applyTurn(credited, turn([{ add: { list: "in_flight", item: { id: "i9", text: "scratch" } } }]), {}).promoted.length === 0);
ok("a verify transition promotes",
  applyTurn(credited, turn([]), { verify: { tested: true, exit: 0, cmd: "suite" } }).promoted.some(p => p.kind === "verify"));
ok("an empty delta promotes nothing", applyTurn(credited, turn([]), {}).promoted.length === 0);
ok("promotionPlan is pure: same inputs, same plan",
  JSON.stringify(promotionPlan(credited, moved.state)) === JSON.stringify(promotionPlan(credited, moved.state)));

done();

#!/usr/bin/env node
// Trantor State P4 — derive (TDD §4.5). The suite's centre of gravity is one property, and it is
// the reason a derived state is safe to build at all:
//
//   A DERIVED STATE CARRIES NO CREDIT.
//
// Every path is verified:false, `verify` is empty, and neither is reachable from a patch. So a
// derived state satisfies neither route (a) nor route (b), no item in it can move to `done`, and a
// successor that wants credit has to earn it from a gate that actually runs. Without those
// assertions this module is a laundering path: unverified work walks through a handoff and comes
// out the other side looking finished.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPS, ERR, stateError } from "../../lib/state/schema.mjs";
import { applyTurn } from "../../lib/state/apply.mjs";
import { deriveState, deriveFiles, parseHandoffState, DERIVED_NOTE } from "../../lib/state/derive.mjs";
import { harness, turn } from "./_helpers.mjs";

const { ok, done } = harness();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = join(ROOT, ".agent-bus-out", "derive-fixtures");
mkdirSync(FIXTURES, { recursive: true });
const CARD = 6909;
const SEAT = "claude";

const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });
const write = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };

/** A repo with one committed file and, unless told otherwise, two dirty ones. */
function tempRepo({ dirty = true } = {}) {
  const dir = mkdtempSync(join(FIXTURES, "repo-"));
  git(["init", "-q", "-b", "main"], dir);
  write(join(dir, "lib", "state", "derive.mjs"), "export const a = 1;\n");
  git(["add", "-A"], dir);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], dir);
  if (dirty) {
    write(join(dir, "lib", "state", "derive.mjs"), "export const a = 2;\n");
    write(join(dir, "test", "state", "test-derive.mjs"), "// new\n");
  }
  return dir;
}

const HANDOFF = `## TASK
Build the Phase-1 handoff path so a handoff carries structured state.

## STATE
- ✅ derive.mjs written @lib/state/derive.mjs
- parser still rough around nested bullets
- done: pulled main and read the design

### Blockers
- ⛔ P5 assemble is not merged yet

## OPEN THREADS & NEXT STEPS
- write test-handoff-state.mjs
- wire attachState into the manual path

## KEY DECISIONS
- route the STATE block through applyTurn, never a second parser

## KEY FILES & locations
- lib/state/derive.mjs
`;

// --- the parser: what a handoff's own sections mean -------------------------------------------
{
  const p = parseHandoffState(HANDOFF);
  ok("a ✅ bullet in STATE reads as done", p.done.includes("derive.mjs written @lib/state/derive.mjs"), JSON.stringify(p.done));
  ok("an inline `done:` label reads as done", p.done.includes("pulled main and read the design"), JSON.stringify(p.done));
  ok("an UNLABELLED STATE bullet defaults to in_flight, never done",
    p.in_flight.length === 1 && !p.done.some(t => /parser still rough/.test(t)), JSON.stringify(p));
  ok("OPEN THREADS & NEXT STEPS is the next list", p.next.length === 2, JSON.stringify(p.next));
  ok("a Blockers sub-heading fills blockers", p.blockers.length === 1, JSON.stringify(p.blockers));
  ok("KEY DECISIONS and KEY FILES contribute no items",
    p.done.length + p.in_flight.length + p.next.length + p.blockers.length === 6, JSON.stringify(p));
  ok("the TASK section yields the task line", /Phase-1 handoff path/.test(p.task), p.task);
}
{
  const p = parseHandoffState("## STATE\nsome prose about the work, not an item\n\n- a real bullet\n");
  ok("prose inside STATE is not an item", p.in_flight.length === 1 && p.in_flight[0] === "a real bullet", JSON.stringify(p));
  ok("a null handoff parses to empty lists", parseHandoffState(null).next.length === 0);
}

// --- files: ground truth from git, and no credit ----------------------------------------------
{
  const dir = tempRepo();
  const files = deriveFiles(dir);
  ok("git's dirty paths become files", Boolean(files["lib/state/derive.mjs"] && files["test/state/test-derive.mjs"]), JSON.stringify(files));
  ok("EVERY derived path is touched:true, verified:false",
    Object.values(files).every(f => f.touched === true && f.verified === false), JSON.stringify(files));
  ok("no derived path carries a hash", Object.values(files).every(f => f.hash === undefined), JSON.stringify(files));
  rmSync(dir, { recursive: true, force: true });
}
{
  // The -z lesson (#6901), on this path too: porcelain C-quotes a non-ASCII path and the key would
  // name a file that does not exist.
  const dir = tempRepo({ dirty: false });
  write(join(dir, "café.mjs"), "x\n");
  const files = deriveFiles(dir);
  ok("a non-ASCII path arrives literal, not C-quoted", Boolean(files["café.mjs"]), JSON.stringify(Object.keys(files)));
  ok("no derived key carries an escape sequence", !Object.keys(files).some(p => /\\[0-9]{3}/.test(p)), JSON.stringify(Object.keys(files)));
  rmSync(dir, { recursive: true, force: true });
}
{
  ok("no worktree derives no files", Object.keys(deriveFiles("")).length === 0);
}

// --- the derived state ------------------------------------------------------------------------
const REPO = tempRepo();
const derived = deriveState({ project: "trantor", seat: SEAT, card: CARD, worktree: REPO, handoffText: HANDOFF });
{
  ok("a derived state is schema-valid", stateError(derived) === "", stateError(derived));
  ok("card comes from the record", derived.card === CARD, String(derived?.card));
  ok("cursor.by is the seat's bus id", derived.cursor.by === "claude:trantor", derived.cursor.by);
  ok("the four lists carry the handoff's items",
    derived.done.length === 2 && derived.in_flight.length === 1 && derived.next.length === 2 && derived.blockers.length === 1,
    JSON.stringify({ d: derived.done.length, f: derived.in_flight.length, n: derived.next.length, b: derived.blockers.length }));
  ok("the evidence marker was extracted into paths, not left in the prose",
    derived.done[0].paths?.[0] === "lib/state/derive.mjs" && !derived.done[0].text.includes("@"),
    JSON.stringify(derived.done[0]));
  ok("notes always name the missing gate", derived.notes.includes(DERIVED_NOTE), derived.notes);
}

// --- the property this whole suite exists for --------------------------------------------------
{
  ok("verify is EMPTY on a derived state — route (a) is closed",
    Object.keys(derived.verify).length === 0, JSON.stringify(derived.verify));
  ok("every derived path is verified:false — route (b) is closed",
    Object.values(derived.files).every(f => f.verified === false), JSON.stringify(derived.files));

  const move = (id, from) => applyTurn(derived, turn([{ move: { id, from, to: "done" } }]), { now: 1, by: SEAT });
  const f1 = move("f1", "in_flight");
  ok("no derived in-flight item can move to done", !f1.ok && f1.code === ERR.NEEDS_GATE, JSON.stringify(f1));
  const n1 = move("n1", "next");
  ok("no derived next item can move to done", !n1.ok && n1.code === ERR.NEEDS_GATE, JSON.stringify(n1));
  const b1 = move("b1", "blockers");
  ok("no derived blocker can move to done", !b1.ok && b1.code === ERR.NEEDS_GATE, JSON.stringify(b1));

  // The item the model itself marked ✅ and named a path for is the tempting one: its path IS in
  // `files`, so route (b) would grant it credit the moment anything set verified:true.
  const claimed = deriveState({
    project: "trantor", seat: SEAT, card: CARD, worktree: REPO,
    handoffText: "## STATE\n- in progress: finish derive @lib/state/derive.mjs\n",
  });
  const c = applyTurn(claimed, turn([{ move: { id: "f1", from: "in_flight", to: "done" } }]), { now: 1, by: SEAT });
  ok("an item naming a real touched path still cannot move to done — touched is not credited",
    !c.ok && c.code === ERR.NEEDS_GATE, JSON.stringify(c));
}

// --- a self-declared verification is rejected by the write matrix, not by a parser --------------
{
  const bad = (patch) => applyTurn(derived, turn(patch), { now: 1, by: SEAT });
  const v = bad([{ set: { field: "verify", value: { tested: true, exit: 0 } } }]);
  ok("set verify → READONLY_FIELD", !v.ok && v.code === ERR.READONLY_FIELD, JSON.stringify(v));
  const vf = bad([{ set: { field: "verify.tested", value: true } }]);
  ok("set verify.tested → READONLY_FIELD", !vf.ok && vf.code === ERR.READONLY_FIELD, JSON.stringify(vf));
  const f = bad([{ set: { field: "files", value: { "lib/state/derive.mjs": { touched: true, verified: true } } } }]);
  ok("set files → READONLY_FIELD", !f.ok && f.code === ERR.READONLY_FIELD, JSON.stringify(f));
  const one = bad([{ set: { field: "files.lib/state/derive.mjs", value: { verified: true } } }]);
  ok("set one file's verified → READONLY_FIELD", !one.ok && one.code === ERR.READONLY_FIELD, JSON.stringify(one));
  // And the state on disk is untouched by any of it — a rejection applies nothing.
  ok("a rejected self-declaration leaves the state uncredited",
    Object.values(derived.files).every(x => x.verified === false), JSON.stringify(derived.files));
}

// --- the task ----------------------------------------------------------------------------------
{
  const t = deriveState({ project: "trantor", seat: SEAT, card: CARD, worktree: REPO, handoffText: HANDOFF, cardTitle: "P4 — the Phase-1 handoff path" });
  ok("the card title wins over the handoff's TASK section", t.task === "P4 — the Phase-1 handoff path", t.task);
  const long = deriveState({ project: "trantor", seat: SEAT, card: CARD, worktree: REPO, handoffText: "", cardTitle: "x".repeat(CAPS.TASK + 200) });
  ok("an over-long card title is capped at CAPS.TASK", long.task.length === CAPS.TASK, String(long.task.length));
  ok("a capped task still leaves a schema-valid state", stateError(long) === "", stateError(long));
  const none = deriveState({ project: "trantor", seat: SEAT, card: CARD, worktree: REPO, handoffText: "## STATE\n- a thing\n" });
  ok("no title and no TASK section leaves task empty, not invalid", none.task === "" && stateError(none) === "", stateError(none));
}

// --- a missing or rejected patch still yields a schema-valid state ------------------------------
{
  const empty = deriveState({ project: "trantor", seat: SEAT, card: CARD, worktree: REPO, handoffText: "" });
  ok("an empty handoff still derives a valid state", stateError(empty) === "", stateError(empty));
  ok("…with the git-derived files intact", Object.keys(empty.files).length === 2, JSON.stringify(empty.files));
  ok("…and no items invented", empty.done.length + empty.in_flight.length + empty.next.length + empty.blockers.length === 0);

  // A marker naming more paths than CAPS.ITEM_PATHS is a CAP rejection of the WHOLE patch (all-or-
  // nothing is what makes "no valid patch corrupts state" true). The state survives it.
  const overMarker = `## STATE\n- shipped the lot @a.mjs,b.mjs,c.mjs,d.mjs,e.mjs,f.mjs,g.mjs,h.mjs,i.mjs\n`;
  const rejected = deriveState({ project: "trantor", seat: SEAT, card: CARD, worktree: REPO, handoffText: overMarker, cardTitle: "P4" });
  ok("a rejected patch still yields a schema-valid state", stateError(rejected) === "", stateError(rejected));
  ok("…keeping the task", rejected.task === "P4", rejected.task);
  ok("…keeping the git-derived files", Object.keys(rejected.files).length === 2, JSON.stringify(rejected.files));
  ok("…and naming the rejection code in notes", rejected.notes.includes(ERR.CAP), rejected.notes);
  ok("…while carrying no items at all", rejected.in_flight.length === 0 && rejected.done.length === 0, JSON.stringify(rejected));
}

// --- caps: overflow is named, never silent ------------------------------------------------------
{
  const many = `## OPEN THREADS & NEXT STEPS\n${Array.from({ length: CAPS.LIST + 5 }, (_, i) => `- step ${i}`).join("\n")}\n`;
  const s = deriveState({ project: "trantor", seat: SEAT, card: CARD, worktree: REPO, handoffText: many });
  ok("a list over CAPS.LIST is carried up to the cap", s.next.length === CAPS.LIST, String(s.next.length));
  ok("…and the drop is NAMED in notes, not silent", /5 next line\(s\) over CAPS.LIST/.test(s.notes), s.notes);
  ok("…leaving a schema-valid state", stateError(s) === "", stateError(s));
}

// --- degenerate inputs never produce a half-built state -----------------------------------------
{
  const noCard = deriveState({ project: "trantor", seat: SEAT, worktree: REPO, handoffText: HANDOFF });
  ok("a handoff with no card derives card 0, still valid", noCard.card === 0 && stateError(noCard) === "", stateError(noCard));
  const junk = deriveState({ project: "trantor", seat: SEAT, card: -1, worktree: "/nonexistent-worktree", handoffText: 42 });
  ok("a negative card and a junk handoff still derive a valid state", stateError(junk) === "", stateError(junk));
  ok("deriveState with no arguments at all returns a valid state, not a throw", stateError(deriveState()) === "");
}

rmSync(REPO, { recursive: true, force: true });
done();

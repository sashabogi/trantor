// #13989: the board's pure rules: testing split, nesting, filters, the drill line, moves.
import { describe, expect, it } from "vitest";
import type { PresenceState } from "../../../shared/presence";
import { allowedMoves, buildBoard, buildNesting, drillLine, drillState, NO_FILTERS, splitTesting, type BoardCard } from "./model";

const NOW = 1_800_000_000_000;
const DAY = 864e5;
const card = (id: number, status: string, extra: Partial<BoardCard> = {}): BoardCard =>
  ({ id, project: "p", title: `card ${id}`, status, updated: NOW - 1000, ...extra });
const presence = new Map<string, PresenceState>([["busy-seat", "busy"], ["idle-seat", "idle"]]);

describe("splitTesting", () => {
  it("separates needs-your-drill, gate-running and older-than-7-days", () => {
    const cards = [
      card(1, "testing", { assignee: "idle-seat" }),
      card(2, "testing", { assignee: "busy-seat" }),
      card(3, "testing", { assignee: "idle-seat", updated: NOW - 8 * DAY }),
      card(4, "testing"),
    ];
    const s = splitTesting(cards, presence, NOW);
    expect(s.needs.map(c => c.id)).toEqual([1, 4]);
    expect(s.gate.map(c => c.id)).toEqual([2]);
    expect(s.older.map(c => c.id)).toEqual([3]);
  });
});

describe("buildBoard", () => {
  const cards = [card(1, "todo"), card(2, "doing", { assignee: "busy-seat" }), card(3, "testing", { assignee: "idle-seat" }),
    card(4, "done"), card(5, "failed"), card(6, "testing", { assignee: "busy-seat" })];

  it("groups cards into lanes and keeps exception lanes separate", () => {
    const m = buildBoard(cards, NO_FILTERS, presence, NOW);
    expect([m.todo, m.doing, m.testing, m.done, m.failed].map(l => l.cards.length)).toEqual([1, 1, 2, 1, 1]);
    expect(m.blocked.cards).toHaveLength(0);
    expect(m.shown).toBe(6);
  });

  it("filters by #id, @seat, seat chips, needs-you and drill-owed", () => {
    const f = (patch: Partial<typeof NO_FILTERS>) => buildBoard(cards, { ...NO_FILTERS, ...patch }, presence, NOW).shown;
    expect(f({ query: "#3" })).toBe(1);
    expect(f({ query: "@busy" })).toBe(2);
    expect(f({ seats: ["idle-seat"] })).toBe(1);
    expect(f({ needsYou: true })).toBe(2);
    expect(f({ drillOwed: true })).toBe(2);
  });

  it("nests sub-agents under their parent session card, and keeps the parent when a child matches", () => {
    const all = [card(10, "doing", { source: "session", cc: "abc" }), card(11, "doing", { source: "cc-subagent", parent: "abc", title: "scout" }),
      card(12, "doing", { source: "cc-subagent", parent: "zzz" })];
    expect(buildNesting(all).childrenOf.get(10)?.map(c => c.id)).toEqual([11]);
    const m = buildBoard(all, NO_FILTERS, presence, NOW);
    expect(m.doing.cards.map(c => c.id)).toEqual([10]);
    expect(m.doing.subagents.map(c => c.id)).toEqual([12]);
    expect(buildBoard(all, { ...NO_FILTERS, query: "scout" }, presence, NOW).doing.cards.map(c => c.id)).toEqual([10]);
    expect(buildBoard(all, { ...NO_FILTERS, nested: false }, presence, NOW).doing.cards).toHaveLength(3);
  });
});

describe("drill line and moves", () => {
  it("accepts the drill field, a Drill: checklist item or a Drill: log note", () => {
    expect(drillLine(card(1, "testing"))).toBeNull();
    expect(drillLine(card(1, "testing", { drill: "reboot the Mac" }))).toBe("reboot the Mac");
    expect(drillLine(card(1, "testing", { checklist: [{ text: "Drill: open the app", done: false }] }))).toBe("open the app");
    expect(drillLine(card(1, "testing", { log: [{ ts: 1, by: "x", text: "Drill: tap it" }] }))).toBe("tap it");
  });

  it("reads drill state per lane", () => {
    expect(drillState(card(1, "testing"))).toBe("none");
    expect(drillState(card(1, "testing", { drill: "x" }))).toBe("owed");
    expect(drillState(card(1, "done", { drill: "x" }))).toBe("set");
    expect(drillState(card(1, "todo"))).toBeNull();
  });

  it("moves forward one step, back to any earlier stage, and exception lanes re-enter early", () => {
    expect(allowedMoves("testing")).toEqual(["todo", "doing", "done"]);
    expect(allowedMoves("todo")).toEqual(["doing"]);
    expect(allowedMoves("failed")).toEqual(["todo", "doing"]);
  });
});

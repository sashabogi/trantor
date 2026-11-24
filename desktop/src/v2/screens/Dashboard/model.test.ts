// #13984 drill: the needs-you queue drops stale inbox messages and week-old testing cards.
import { describe, expect, it } from "vitest";
import type { Card, Message } from "../../../shared/api/client";
import { buildQueue, oldTesting } from "./model";

const NOW = 1_800_000_000_000;
const DAY = 864e5;
const card = (id: number, status: string, ageDays: number, project = "p"): Card =>
  ({ id, project, title: `card ${id}`, status, updated: NOW - ageDays * DAY });
const msg = (id: number, from: string, extra: Partial<Message> = {}): Message =>
  ({ id, ts: NOW - 1000, from, to: "sasha", project: "p", text: "hi", ...extra });
const base = { holds: [], proposals: [], decided: new Set<string>(), now: NOW };

describe("buildQueue", () => {
  it("drops messages the Inbox calls stale (asked again, or every cited card closed)", () => {
    const messages = [msg(1, "kimi"), msg(2, "kimi"), msg(3, "glm", { refs: [9] }), msg(4, "codex")];
    const cards = [card(9, "done", 1)];
    const q = buildQueue({ ...base, cards, messages });
    expect(q.map(i => i.key)).toEqual(["message:2", "message:4"]);
  });

  it("sees a newer message that the unseen list no longer holds", () => {
    const q = buildQueue({ ...base, cards: [], messages: [msg(1, "kimi")], allMessages: [msg(1, "kimi"), msg(2, "kimi")] });
    expect(q).toEqual([]);
  });

  it("leaves testing cards over a week out of the rows, keeps fresh ones, keeps the ranking", () => {
    const cards = [card(1, "testing", 30), card(2, "testing", 8), card(3, "testing", 1)];
    const q = buildQueue({ ...base, cards, messages: [msg(5, "kimi")] });
    expect(q.map(i => i.key)).toEqual(["message:5", "testing:3"]);
  });
});

describe("oldTesting", () => {
  it("counts testing cards past 7 days and names the project holding most", () => {
    const cards = [card(1, "testing", 9, "a"), card(2, "testing", 20, "b"), card(3, "testing", 30, "b"), card(4, "testing", 2, "a"), card(5, "doing", 40, "a")];
    expect(oldTesting(cards, NOW)).toEqual({ count: 3, project: "b" });
    expect(oldTesting([], NOW)).toEqual({ count: 0, project: "" });
  });
});

// #13984 drill: the needs-you queue drops stale inbox messages and rolls up week-old testing cards.
import { describe, expect, it } from "vitest";
import type { Card, Message, Peer } from "../../../shared/api/client";
import { actionableCount, activeProjects, buildQueue, dashboardGroups, liveSeats } from "./model";

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

  it("rolls old testing cards up per project, ranks them last, and keeps fresh drills", () => {
    const cards = [card(1, "testing", 30, "a"), card(2, "testing", 8, "b"), card(3, "testing", 20, "b"), card(4, "testing", 1, "a")];
    const q = buildQueue({ ...base, cards, messages: [msg(5, "kimi-9:trantor")] });
    expect(q.map(i => i.key)).toEqual(["message:5", "testing:old:a", "testing:old:b", "testing:4"]);
    expect(q[1]).toMatchObject({ testingCount: 1, title: "a: 1 card in testing over a week" });
    expect(q[2]).toMatchObject({ testingCount: 2, title: "b: 2 cards in testing over a week", ts: NOW - 20 * DAY });
    expect(q[0].title).toBe("kimi-9: hi");
    expect(actionableCount(q)).toBe(1);
  });
});

describe("liveSeats", () => {
  const doing = [{ ...card(1, "doing", 0, "trantor"), assignee: "kimi-9" }];
  const localWorking = new Map([["trantor", { state: "working", evidence: "herdr sees this pane working" } as const]]);

  it("never infers working from a stale doing card or another seat's local activity", () => {
    const peers: Peer[] = [{ session: "kimi-9:trantor", project: "trantor", status: "active in trantor", lastSeen: NOW, online: true }];
    const seats = liveSeats(peers, doing, NOW, localWorking);
    expect(seats).toHaveLength(1);
    expect(seats[0].presence).toBe("ready");
    expect(seats[0].card?.id).toBe(1);
  });

  it("uses herdr working activity for a local orchestrator with generic MCP presence", () => {
    const peers: Peer[] = [{ session: "MacBook-Pro-M1:trantor", project: "trantor", status: "active in trantor", lastSeen: NOW, online: true }];
    expect(liveSeats(peers, doing, NOW, localWorking)[0].presence).toBe("working");
    expect(liveSeats(peers, doing, NOW)[0].presence).toBe("ready");
  });

  it("uses the runner's hub working status without local activity", () => {
    const peers: Peer[] = [{ session: "kimi-9:trantor", project: "trantor", status: "working · card 14049", lastSeen: NOW, online: true }];
    expect(liveSeats(peers, doing, NOW)[0].presence).toBe("working");
  });

  it("does not turn an explicitly idle seat into a working one", () => {
    const peers: Peer[] = [{ session: "kimi-9:trantor", project: "trantor", status: "idle", lastSeen: NOW, online: true }];
    expect(liveSeats(peers, doing, NOW)[0].presence).toBe("ready");
  });
});

describe("dashboardGroups", () => {
  it("regroups queues and seats with readable project and seat labels", () => {
    const cards = [card(1, "testing", 9, "trantor")];
    const items = buildQueue({ ...base, cards, messages: [msg(2, "kimi-9:trantor", { project: "trantor" })] });
    const seats = liveSeats([{ session: "kimi-9:trantor", project: "trantor", status: "working", lastSeen: NOW }], cards, NOW);
    expect(dashboardGroups("project", items, seats).map(g => g.label)).toEqual(["trantor"]);
    expect(dashboardGroups("agent", items, seats).map(g => g.label)).toEqual(["kimi-9", "trantor reviews"]);
  });
});

describe("activeProjects", () => {
  it("keeps live projects and cards moved within 14 days", () => {
    const projects = ["live", "recent", "old", "empty"];
    const cards = [card(1, "done", 13, "recent"), card(2, "done", 15, "old")];
    expect([...activeProjects(projects, cards, ["live"], NOW)].sort()).toEqual(["live", "recent"]);
  });
});

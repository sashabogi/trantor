// @vitest-environment happy-dom
// #13992: roster sort, presence from lastSeen, and the autonomy ladder writing through the client.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubClient, type Peer } from "../../../shared/api/client";
import { AutonomyLadder } from "./AutonomyLadder";
import { isHostSession } from "../Workspace/seatModel";
import { headerCounts, noticeSeat, presenceOf, rosterSort, toSeatViews, vendorOf } from "./model";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_000_000_000_000;
const peer = (session: string, agoMs: number, extra: Partial<Peer> = {}): Peer => ({ session, project: "trantor", lastSeen: NOW - agoMs, ...extra });

describe("presence", () => {
  it("reads working, ready and offline from lastSeen", () => {
    const none = new Set<string>();
    expect(presenceOf(peer("a", 10_000), none, NOW)).toBe("working");
    expect(presenceOf(peer("a", 3 * 60_000), none, NOW)).toBe("ready");
    expect(presenceOf(peer("a", 6 * 60_000), none, NOW)).toBe("offline");
  });
  it("a seat with an open ask is needs-you, unless it is offline", () => {
    const ask = new Set(["a"]);
    expect(presenceOf(peer("a", 10_000), ask, NOW)).toBe("needs-you");
    expect(presenceOf(peer("a", 6 * 60_000), ask, NOW)).toBe("offline");
  });
  it("finds the vendor from the session brand", () => {
    expect(vendorOf(peer("codex:trantor", 0))).toBe("Codex");
    expect(vendorOf(peer("x", 0, { llm: "glm" }))).toBe("GLM");
  });
  it("flags the operator's host session and no crew seat, whatever the case", () => {
    expect(isHostSession("MacBook-Pro-M1:trantor")).toBe(true);
    expect(isHostSession("macbook-pro-m1:ember")).toBe(true);
    expect(isHostSession("codex-8:trantor")).toBe(false);
    expect(isHostSession("claude:trantor-duty")).toBe(false);
  });
  it("reads the seat a crew notice is about, and a seatless line belongs to no card", () => {
    expect(noticeSeat("codex-8 · no runner for codex-8")).toBe("codex-8");
    expect(noticeSeat("kimi · done")).toBe("kimi");
    expect(noticeSeat("Seat catalog unavailable for trantor: boom")).toBe("");
    expect(noticeSeat("done")).toBe("");
  });
});

describe("roster", () => {
  const views = toSeatViews([
    peer("ready-1", 2 * 60_000), peer("working-1", 5_000), peer("needs-1", 20_000), peer("gone", 9 * 60_000), peer("working-2", 1_000),
  ], new Set(["needs-1"]), NOW);
  it("sorts needs you, then working, then ready, then offline", () => {
    expect(rosterSort(views).map(v => v.peer.session)).toEqual(["needs-1", "working-2", "working-1", "ready-1", "gone"]);
  });
  it("counts the header from the same views", () => {
    expect(headerCounts(views)).toMatchObject({ live: 4, working: 2, needsYou: 1, offline: 1 });
    expect(headerCounts(views).offlineNames).toEqual(["gone in trantor"]);
  });
  it("names offline seats as a person reads them: seat in project, never a raw host session id (#14062)", () => {
    const off = toSeatViews([
      peer("MacBook-Pro-M1:Ember", 9 * 60_000, { project: "Ember" }),
      peer("MacBook-Pro-M1:rock-os", 9 * 60_000, { project: "" }),
      peer("glm-2:trantor", 9 * 60_000),
    ], new Set(), NOW);
    expect(headerCounts(off).offlineNames).toEqual(["orchestrator in Ember", "orchestrator in rock-os", "glm-2 in trantor"]);
    expect(headerCounts(off).offlineNames.join(", ")).not.toContain("MacBook");
  });
});

describe("autonomy ladder", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  function mount(level: number) {
    const transport = vi.fn(async () => ({ status: 200, body: "{}" }));
    const client = new HubClient("http://hub.test", transport);
    const run = vi.fn(async (action: () => Promise<string>) => { await action(); });
    act(() => { root.render(<AutonomyLadder client={client} project="trantor" level={level} busy={false} run={run} />); });
    return transport;
  }
  const press = (label: string) => act(async () => { host.querySelector<HTMLElement>(`[aria-label="${label}"]`)?.click(); });

  it("raises one rung through client.setAutonomy", async () => {
    const transport = mount(2);
    await press("Raise one rung");
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ method: "POST", path: "/policy", body: JSON.stringify({ autonomy: { trantor: 3 } }) }));
  });
  it("lowers one rung, and stops at the ends", async () => {
    const transport = mount(2);
    await press("Lower one rung");
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ body: JSON.stringify({ autonomy: { trantor: 1 } }) }));
    act(() => root.unmount()); root = createRoot(host);
    const edge = mount(1);
    await press("Lower one rung");
    expect(edge).not.toHaveBeenCalled();
  });
});

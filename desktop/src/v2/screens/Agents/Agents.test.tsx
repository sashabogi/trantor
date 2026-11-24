// @vitest-environment happy-dom
// #13992: roster sort, presence from lastSeen, and the autonomy ladder writing through the client.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubClient, type Peer } from "../../../shared/api/client";
import { AutonomyLadder } from "./AutonomyLadder";
import { headerCounts, presenceOf, rosterSort, toSeatViews, vendorOf } from "./model";
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

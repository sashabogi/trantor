// @vitest-environment happy-dom
// #13990: rank by released work, group stale questions, and answer without leaving the inbox.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { HubClient, type Card, type Message } from "../../../shared/api/client";
import { hasSeen } from "../../../shared/seen";
import { InboxScreen } from "./index";
import { makeInboxItems, rankInboxItems, splitStaleItems } from "./model";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const message = (id: number, from: string, refs: number[] = [], ts = id * 1000): Message => ({
  id, from, to: "sasha", project: "trantor", text: `Question ${id}`, refs, ts,
});
const card = (id: number, status: string): Card => ({ id, status, project: "trantor", title: `Card ${id}` });

describe("Inbox model", () => {
  it("ranks open card references and held seats ahead of waiting questions", () => {
    const items = makeInboxItems({
      messages: [message(1, "codex-8", [11], 100), message(2, "glm-5", [11, 12], 50)],
      proposals: [{ id: 3, session: "kimi-9", project: "trantor", scope: "restart", condition: "dead", exclusions: "live", status: "pending", ts: 300 }],
      holds: [{ id: 4, project: "trantor", file: "src/a.ts", session: "codex-8", other: "glm-5", status: "pending", ts: 200 }],
      peers: [], cards: [card(11, "doing"), card(12, "todo"), card(13, "done")],
    });
    expect(rankInboxItems(items).map(item => item.key)).toEqual([
      "hold-trantor-4", "message-2", "proposal-trantor-3", "message-1",
    ]);
    expect(rankInboxItems(items, "newest")[0]?.key).toBe("proposal-trantor-3");
  });

  it("groups superseded and fully closed questions as stale with their reasons", () => {
    const items = makeInboxItems({
      messages: [message(10, "codex-8"), message(11, "codex-8"), message(12, "kimi-9", [20]), message(13, "glm-5", [21])],
      proposals: [], holds: [], peers: [], cards: [card(20, "done"), card(21, "testing")],
    });
    const groups = splitStaleItems(items);
    expect(groups.live.map(item => item.key)).toEqual(["message-11", "message-13"]);
    expect(groups.stale.map(item => item.key)).toEqual(["message-10", "message-12"]);
    expect(groups.stale[0]?.stale).toEqual({ stale: true, reason: "codex-8 asked again since" });
    expect(groups.stale[1]?.stale).toEqual({ stale: true, reason: "#20 is done" });
  });
});

describe("InboxScreen", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); }, clear: () => storage.clear(), key: () => null, length: 0,
    });
    mockIPC(command => command === "identity_name" ? "sasha" : command === "plugin:event|listen" ? 1 : null);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    clearMocks();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends a quick answer, acknowledges the message, and removes it from Needs you", async () => {
    const client = new HubClient("http://test");
    const mail = { ...message(7001, "codex-8:trantor", [42], Date.now()), text: "Ship the fix?" };
    const inbox = vi.spyOn(client, "inbox").mockResolvedValue({ messages: [mail], cursor: 7001 });
    vi.spyOn(client, "tasks").mockResolvedValue([card(42, "doing")]);
    vi.spyOn(client, "peers").mockResolvedValue([]);
    vi.spyOn(client, "proposals").mockResolvedValue({ proposals: [], pendingCount: 0 });
    vi.spyOn(client, "holds").mockResolvedValue({ holds: [] });
    vi.spyOn(client, "streamEvents").mockReturnValue(() => {});
    const send = vi.spyOn(client, "send").mockResolvedValue({ ok: true, id: 7002 });
    const delivered = vi.spyOn(client, "delivered").mockResolvedValue();

    await act(async () => { root.render(<InboxScreen client={client} project="" onNavigate={vi.fn()} />); });
    expect(inbox).toHaveBeenCalledWith("sasha");
    const answer = [...host.querySelectorAll("button")].find(button => button.textContent === "Go ahead");
    expect(answer).toBeDefined();
    await act(async () => { answer?.click(); });

    expect(send).toHaveBeenCalledWith("codex-8:trantor", "Go ahead", "trantor");
    expect(delivered).toHaveBeenCalledWith(7001);
    expect(hasSeen(7001)).toBe(true);
    expect(host.querySelector('[data-inbox-key="message-7001"]')).toBeNull();
    expect(host.textContent).toContain("Nothing waiting on you.");
  });
});

// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { HubEvent, Peer } from "../../shared/api/client";
import { useNotifications } from "./useNotifications";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// The native commands are faked at the IPC seam; each send records its title.
let sent: string[] = [];

let emit: ((ev: HubEvent) => void) | null = null;
let stopped = 0;
const client = {
  peers: async (): Promise<Peer[]> => [],
  streamEvents: (onEvent: (ev: HubEvent) => void) => { emit = onEvent; return () => { stopped += 1; emit = null; }; },
};

function Shell({ me }: { me: string }) {
  useNotifications(client, me);
  return null;
}

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });

beforeEach(() => {
  sent = []; stopped = 0; emit = null;
  mockIPC((command, args) => {
    if (command === "notify_permission") return "granted";
    if (command === "notify_send") {
      // SAFETY: mockIPC types args as unknown; notify_send is invoked with named title/body.
      sent.push((args as { title: string }).title);
    }
    return null;
  });
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
  vi.spyOn(document, "hasFocus").mockImplementation(() => false);
});
afterEach(() => { clearMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("useNotifications", () => {
  it("turns a direct message to the operator into one notification, and stops listening on unmount", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<Shell me="sasha@mac" />));
    await settle();
    emit?.({ ts: 1, type: "message", by: "kimi-9:trantor", toSession: "sasha@mac", text: "done" });
    emit?.({ ts: 2, type: "message", by: "kimi-9:trantor", toSession: "all", text: "broadcast" });
    await settle();
    expect(sent).toEqual(["Message from kimi-9:trantor"]);
    act(() => root.unmount());
    expect(stopped).toBe(1);
  });

  it("does not listen before the identity is known", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<Shell me="" />));
    await settle();
    expect(emit).toBeNull();
    act(() => root.unmount());
  });
});

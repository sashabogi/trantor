// @vitest-environment happy-dom
// #14268: the recipient list closes on Escape, Enter picks the first match, and sending reaches the bus.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubClient, type HubEvent, type Peer } from "../../shared/api/client";
import { Messages } from "./Messages";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const must = <T extends Element>(el: T | null): T => { if (!el) throw new Error("element not found"); return el; };
const now = Date.now();
const EVENTS: HubEvent[] = [{ id: 1, ts: now - 60_000, type: "message", by: "kimi-9:trantor", toSession: "glm-5:trantor", project: "trantor", text: "the diff is ready" }];
const PEERS: Peer[] = [{ session: "codex-2:trantor", project: "trantor", lastSeen: now }, { session: "glm-5:trantor", project: "trantor", lastSeen: now }];

let host: HTMLDivElement;
let root: Root;
let client: HubClient;
beforeEach(() => {
  client = new HubClient("http://127.0.0.1:1");
  vi.spyOn(client, "events").mockResolvedValue({ events: EVENTS });
  vi.spyOn(client, "peers").mockResolvedValue(PEERS);
  vi.spyOn(client, "streamEvents").mockReturnValue(() => {});
  vi.spyOn(client, "send").mockResolvedValue({ ok: true, id: 1 });
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const mount = async () => {
  await act(async () => { root.render(<Messages client={client} me="sasha" />); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};
const newMessage = () => must([...host.querySelectorAll("button")].find(b => b.textContent?.includes("New message")) ?? null);
const type = (el: HTMLInputElement, v: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});

describe("Messages recipient picker", () => {
  it("Escape closes the list", async () => {
    await mount();
    await act(async () => { newMessage().click(); });
    expect(host.querySelector('input[aria-label="Filter sessions"]')).not.toBeNull();
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(host.querySelector('input[aria-label="Filter sessions"]')).toBeNull();
  });

  it("Enter picks the first match and the message goes to that session", async () => {
    await mount();
    await act(async () => { newMessage().click(); });
    const filter = must(host.querySelector<HTMLInputElement>('input[aria-label="Filter sessions"]'));
    await type(filter, "codex");
    await act(async () => { filter.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    const box = must(host.querySelector<HTMLInputElement>('input[placeholder^="Message "]'));
    expect(box.placeholder).toContain("codex-2");
    await type(box, "ping");
    await act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(client.send).toHaveBeenCalledWith("codex-2:trantor", "ping", "trantor");
  });

  it("says when the filter matches nothing", async () => {
    await mount();
    await act(async () => { newMessage().click(); });
    await type(must(host.querySelector<HTMLInputElement>('input[aria-label="Filter sessions"]')), "zzz");
    expect(host.textContent).toContain("No session matches that filter.");
  });

  it("marks the open conversation so a screen reader knows which thread is read", async () => {
    await mount();
    expect(host.querySelector('button[aria-current="true"]')).not.toBeNull();
    expect(host.textContent).not.toContain("—");
  });
});

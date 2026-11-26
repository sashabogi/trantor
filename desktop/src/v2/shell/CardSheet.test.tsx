// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { HubClient, type Card } from "../../shared/api/client";
import { closeCardSheet, currentCardSheet, openCardSheet } from "./cardIntent";
import { CardSheet } from "./CardSheet";

// SAFETY: React's act() reads this flag off globalThis; the cast adds the one key TS does not know.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CARD: Card = { id: 14327, project: "trantor", title: "The chat column", status: "doing" };
const OTHER: Card = { id: 14322, project: "trantor", title: "Onboarding autonomy", status: "done" };

let host: HTMLDivElement;
let root: Root;
let client: HubClient;
beforeEach(() => {
  mockIPC(() => null);
  client = new HubClient("http://unused");
  vi.spyOn(client, "card").mockImplementation(async id => ({ task: id === OTHER.id ? OTHER : CARD, events: [], messages: [] }));
  vi.spyOn(client, "streamEvents").mockReturnValue(() => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => { closeCardSheet(); root.unmount(); }); host.remove(); clearMocks(); vi.restoreAllMocks(); });

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 10)); });
const mount = async () => { await act(async () => { root.render(<CardSheet client={client} />); }); await flush(); };

describe("CardSheet", () => {
  it("shows nothing until a card is opened", async () => {
    await mount();
    expect(host.querySelector('[data-testid="card-sheet"]')).toBeNull();
  });

  it("opening a card shows its detail, and Escape closes it", async () => {
    await mount();
    await act(async () => { openCardSheet("trantor", 14327); });
    await flush();
    const sheet = host.querySelector('[data-testid="card-sheet"]');
    expect(sheet?.getAttribute("aria-label")).toBe("Card #14327");
    expect(sheet?.textContent).toContain("The chat column");
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(host.querySelector('[data-testid="card-sheet"]')).toBeNull();
    expect(currentCardSheet()).toBeNull();
  });

  it("the close button closes it", async () => {
    await mount();
    await act(async () => { openCardSheet("trantor", 14327); });
    await flush();
    const close = [...host.querySelectorAll("button")].find(b => b.textContent === "✕");
    await act(async () => { close?.click(); });
    expect(host.querySelector('[data-testid="card-sheet"]')).toBeNull();
  });

  it("opening another card swaps the detail in place", async () => {
    await mount();
    await act(async () => { openCardSheet("trantor", 14327); });
    await flush();
    await act(async () => { openCardSheet("trantor", 14322); });
    await flush();
    expect(host.querySelector('[data-testid="card-sheet"]')?.textContent).toContain("Onboarding autonomy");
  });
});

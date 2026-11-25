// @vitest-environment happy-dom
// #14268: Settings search keeps rows, keys work in the nav and dials, and the sheets close on Escape.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { PasteKeySheet } from "../../../features/settings/providers/PasteKeySheet";
import { RemoveProviderSheet } from "../../../features/settings/providers/RemoveProviderSheet";
import type { ProviderAccountsApi, ProviderStatus } from "../../../features/settings/providers/providerStatus";
import { DialRow } from "./DialRow";
import { GeneralPage, NotificationsPage } from "./GeneralPages";
import { WorkingAgreements } from "./PolicyCards";
import { SettingsNav } from "./SettingsNav";
import { filterSections, keptRows } from "./sections";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
  mockIPC(() => null);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); vi.unstubAllGlobals(); });

const must = <T extends Element>(el: T | null): T => { if (!el) throw new Error("element not found"); return el; };
const key = (el: Element, k: string) => act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
const titles = () => [...host.querySelectorAll(".text-v2-base.font-medium")].map(e => e.textContent);

describe("Settings search reaches rows", () => {
  it("keptRows keeps matching rows, and every row when only the page matched", () => {
    const words = { a: "open code in editor", b: "updates check now" };
    expect([...keptRows("update", "General", words)]).toEqual(["b"]);
    expect([...keptRows("general", "General", words)]).toEqual(["a", "b"]);
    expect([...keptRows("zzz", "General", words)]).toEqual(["a", "b"]);
  });

  it("General shows only the Updates row for 'update'", async () => {
    await act(async () => { root.render(<GeneralPage query="update" />); });
    expect(titles().join("|")).toMatch(/Updates/);
    expect(titles().join("|")).not.toMatch(/Open code in/);
    expect(titles().join("|")).not.toMatch(/Onboarding/);
  });

  it("General shows every row with no query, and Notifications narrows to the background toggle", async () => {
    await act(async () => { root.render(<GeneralPage />); });
    expect(titles().join("|")).toMatch(/Open code in.*Updates.*Onboarding.*Back to classic/);
    await act(async () => { root.render(<NotificationsPage query="background" />); });
    expect(host.querySelectorAll('[role="switch"]').length).toBe(1);
    expect(host.querySelector('[role="switch"]')?.getAttribute("aria-label")).toBe("Only when Trantor is in the background");
  });

  it("the Notifications blurb promises nothing that is not on the page", () => {
    expect(filterSections("spoken")).toEqual([]);
  });
});

describe("Settings nav keys", () => {
  const nav = (query: string, onQuery = vi.fn()) => act(async () => {
    root.render(<SettingsNav sections={filterSections(query)} active="general" query={query} onQuery={onQuery} onPick={() => {}} />);
  });

  it("Escape clears the search box", async () => {
    const onQuery = vi.fn();
    await nav("dial", onQuery);
    await key(must(host.querySelector("#settings-search")), "Escape");
    expect(onQuery).toHaveBeenCalledWith("");
  });

  it("Down from the search box lands on the first section and Up and Down walk the list", async () => {
    await nav("");
    await key(must(host.querySelector("#settings-search")), "ArrowDown");
    const buttons = [...host.querySelectorAll<HTMLElement>("[data-section]")];
    expect(document.activeElement).toBe(buttons[0]);
    await key(buttons[0], "ArrowDown");
    expect(document.activeElement).toBe(buttons[1]);
    await key(buttons[1], "ArrowUp");
    expect(document.activeElement).toBe(buttons[0]);
  });
});

describe("DialRow", () => {
  const CHOICES = [{ value: "prompt", label: "Ask me" }, { value: "bypass", label: "Skip prompts" }] as const;

  it("has no dead help button, and arrow keys move the choice", async () => {
    const onPick = vi.fn();
    await act(async () => { root.render(<DialRow label="Your session" why="Whether it asks." choices={CHOICES} value="prompt" changed={false} onPick={onPick} />); });
    expect(host.querySelector('[aria-label^="Help for"]')).toBeNull();
    const first = must(host.querySelector('[role="radio"]'));
    await key(first, "ArrowRight");
    expect(onPick).toHaveBeenCalledWith("bypass");
  });
});

describe("Working agreements", () => {
  it("is a read-only list, not a column of disabled checkboxes", async () => {
    await act(async () => { root.render(<WorkingAgreements />); });
    expect(host.querySelector('input[type="checkbox"]')).toBeNull();
    expect(host.querySelectorAll("li").length).toBeGreaterThan(3);
  });
});

const STATUS: ProviderStatus = {
  provider: "deepseek", label: "DeepSeek", kind: "prepaid", connect: "api-key", binary: { name: null, installed: true, path: null },
  auth: { artifact: null, present: true, mode: "key" }, state: "connected", reason: "", usage: null, actions: ["remove", "paste-key"],
};
const API: ProviderAccountsApi = {
  status: async () => ({ available: true, providers: [STATUS] }), login: async () => {},
  verifyKey: vi.fn(async () => STATUS), saveKey: vi.fn(async () => {}), remove: vi.fn(async () => {}),
};

describe("provider sheets", () => {
  it("Escape cancels the remove confirm without removing", async () => {
    const onClose = vi.fn();
    await act(async () => { root.render(<RemoveProviderSheet provider={STATUS} api={API} onClose={onClose} onRemoved={() => {}} onError={() => {}} />); });
    await key(document.body, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(API.remove).not.toHaveBeenCalled();
  });

  it("Enter in the key field verifies and saves", async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    await act(async () => { root.render(<PasteKeySheet provider={STATUS} api={API} onClose={onClose} onSaved={onSaved} />); });
    const input = must(host.querySelector<HTMLInputElement>('input[type="password"]'));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "sk-test");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await key(input, "Enter");
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(API.verifyKey).toHaveBeenCalledWith("deepseek", "sk-test");
    expect(onSaved).toHaveBeenCalled();
  });

  it("Escape closes the paste key sheet while it is idle", async () => {
    const onClose = vi.fn();
    await act(async () => { root.render(<PasteKeySheet provider={STATUS} api={API} onClose={onClose} onSaved={() => {}} />); });
    await key(document.body, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

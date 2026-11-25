// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsPage } from "./GeneralPages";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "tr.notifications.background";
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const mount = async () => { await act(async () => { root.render(<NotificationsPage />); }); };
const toggle = () => host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Only when Trantor is in the background"]');

describe("NotificationsPage background setting", () => {
  it("shows the toggle on by default", async () => {
    await mount();
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
  });

  it("reflects a stored off value", async () => {
    localStorage.setItem(KEY, "off");
    await mount();
    expect(toggle()?.getAttribute("aria-checked")).toBe("false");
  });

  it("writes the value when clicked", async () => {
    await mount();
    await act(async () => { toggle()?.click(); });
    expect(localStorage.getItem(KEY)).toBe("off");
    await act(async () => { toggle()?.click(); });
    expect(localStorage.getItem(KEY)).toBe("on");
  });
});

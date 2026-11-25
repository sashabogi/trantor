// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { useAppUpdate } from "./useAppUpdate";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SIX_HOURS = 6 * 60 * 60 * 1000;
const UPDATE = {
  current: "2.0.0", latest: "2.0.1", tag: "app-v2.0.1", assetName: "Trantor.dmg",
  url: "https://example.test/Trantor.dmg", size: 1, updateAvailable: true,
};

let host: HTMLDivElement;
let root: Root;
let checks = 0;

function Probe() {
  const update = useAppUpdate();
  return <output>{update?.latest ?? ""}</output>;
}

beforeEach(() => {
  vi.useFakeTimers();
  checks = 0;
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => { mem.set(key, value); },
    removeItem: (key: string) => { mem.delete(key); },
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  });
  mockIPC(command => {
    if (command === "app_update_check") { checks += 1; return UPDATE; }
    return null;
  });
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
  vi.useRealTimers();
});

describe("useAppUpdate", () => {
  it("checks at mount and again after six hours", async () => {
    await act(async () => { root.render(<Probe />); });
    expect(checks).toBe(1);
    expect(host.querySelector("output")?.textContent).toBe("2.0.1");

    await act(async () => { await vi.advanceTimersByTimeAsync(SIX_HOURS - 1); });
    expect(checks).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(checks).toBe(2);
  });
});

// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Rail, type RailProps } from "./Rail";
import { takeSettingsSection } from "./settingsIntent";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => { mem.set(key, value); },
    removeItem: (key: string) => { mem.delete(key); },
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mount = (overrides: Partial<RailProps> = {}) => act(() => root.render(<Rail
  screen="dashboard" project="trantor" live={["trantor"]} unread={0} needsYou={0} update={null} onNavigate={() => {}} {...overrides}
/>));
const nav = () => host.querySelector<HTMLElement>('nav[aria-label="Primary"]');
const toggle = () => act(() => host.querySelector<HTMLButtonElement>('button[aria-label$="the sidebar"]')?.click());

describe("Rail", () => {
  it("renders the unchanged icon-only rail when collapsed", () => {
    mount();
    expect(nav()?.dataset.expanded).toBe("false");
    expect(nav()?.className).toContain("w-[58px]");
    expect(nav()?.textContent).not.toContain("Dashboard");
    expect(host.querySelector('button[aria-label="Dashboard"]')?.getAttribute("title")).toBe("Dashboard");
    expect(host.querySelector('button[aria-label="Expand the sidebar"]')?.getAttribute("title")).toBe("Expand the sidebar");
  });

  it("reads the stored expanded choice on the first render", () => {
    localStorage.setItem("trantor.v2.rail.expanded", "true");
    mount();
    expect(nav()?.dataset.expanded).toBe("true");
    expect(nav()?.className).toContain("w-[200px]");
    expect(nav()?.textContent).toContain("Dashboard");
    expect(nav()?.textContent).toContain("trantor");
    expect(host.querySelector('button[aria-label="Dashboard"]')?.hasAttribute("title")).toBe(false);
    expect(host.querySelector('button[aria-label="Collapse the sidebar"]')).not.toBeNull();
  });

  it("toggles both states and stores the choice", () => {
    mount();
    toggle();
    expect(nav()?.dataset.expanded).toBe("true");
    expect(localStorage.getItem("trantor.v2.rail.expanded")).toBe("true");
    toggle();
    expect(nav()?.dataset.expanded).toBe("false");
    expect(localStorage.getItem("trantor.v2.rail.expanded")).toBe("false");
  });

  // #14070: Developer starts on icons whatever Orchestrator stored, keeps its own choice, and opens a project on Code.
  it("keeps a separate choice per mode and opens a project on the mode's lens", () => {
    localStorage.setItem("trantor.v2.rail.expanded", "true");
    localStorage.setItem("trantor.v2.mode", "developer");
    const onNavigate = vi.fn();
    mount({ onNavigate });
    expect(nav()?.dataset.expanded).toBe("false");
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="trantor"]')?.click());
    expect(onNavigate).toHaveBeenCalledWith("code", "trantor");
    toggle();
    expect(localStorage.getItem("trantor.v2.rail.expanded.developer")).toBe("true");
    expect(localStorage.getItem("trantor.v2.rail.expanded")).toBe("true");
  });

  it("keeps the Inbox count and needs-you dot visible in both states", () => {
    mount({ unread: 7, needsYou: 2 });
    expect(host.querySelector('button[aria-label="Inbox, 7 unread"] [data-badge]')?.textContent).toBe("7");
    expect(host.querySelector('[data-project-tile="trantor"] [data-dot="needs-you"]')).not.toBeNull();
    toggle();
    expect(host.querySelector('button[aria-label="Inbox, 7 unread"] [data-badge]')?.textContent).toBe("7");
    expect(host.querySelector('button[aria-label="trantor"] > [data-dot="needs-you"]')).not.toBeNull();
    expect(host.querySelector('[data-project-tile="trantor"] [data-dot="needs-you"]')).toBeNull();
  });

  it("shows the update entry above Settings only when a release is available", () => {
    const onNavigate = vi.fn();
    const update = { current: "2.0.0", latest: "2.0.1", tag: "app-v2.0.1", assetName: "Trantor.dmg", url: "https://example.test/Trantor.dmg", size: 1 };
    mount({ onNavigate });
    expect(host.querySelector('button[aria-label="Update v2.0.1"]')).toBeNull();
    mount({ onNavigate, update: { ...update, updateAvailable: false } });
    expect(host.querySelector('button[aria-label="Update v2.0.1"]')).toBeNull();

    mount({ onNavigate, update: { ...update, updateAvailable: true } });
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Update v2.0.1"]');
    expect(button?.getAttribute("title")).toBe("Update v2.0.1");
    expect(button?.querySelector("svg")).not.toBeNull();
    expect(button?.nextElementSibling).toBe(host.querySelector('button[aria-label="Settings"]'));
    act(() => button?.click());
    expect(onNavigate).toHaveBeenCalledWith("settings");
    expect(takeSettingsSection()).toBe("general");

    toggle();
    expect(host.querySelector('button[aria-label="Update v2.0.1"]')?.textContent).toBe("Update v2.0.1");
  });
});

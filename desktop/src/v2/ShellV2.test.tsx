// @vitest-environment happy-dom
// #v2-F: the shell mounts on the real client calls, routes every rail entry, frames project
// screens with the lens tabs, and offers Back to classic.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { ShellV2 } from "./ShellV2";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// One empty body that satisfies every list endpoint the shell polls.
const EMPTY = JSON.stringify({ peers: [], messages: [], cursor: 0, tasks: [], proposals: [], holds: [], entries: [], machines: [], ts: Date.now(), staleAfterMs: 90_000 });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
  mockIPC(command => {
    if (command === "known_projects") return ["crebral-cortex", "trantor"];
    if (command === "hub_for_project") return "http://127.0.0.1:4477";
    if (command === "identity_name") return "sasha";
    if (command === "local_sessions") return [{ project: "trantor", status: "working" }];
    if (command === "hub_request") return { status: 200, body: EMPTY };
    if (command === "plugin:event|listen") return 1;
    return null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const mount = () => act(async () => { root.render(<ShellV2 />); });
const click = (sel: string) => act(async () => { host.querySelector<HTMLElement>(sel)?.click(); });
const heading = () => host.querySelector("main h1")?.textContent;

describe("ShellV2", () => {
  it("opens on the dashboard with the full rail and the plans bar", async () => {
    await mount();
    expect(heading()).toBe("Dashboard");
    const rail = host.querySelector('nav[aria-label="Primary"]');
    for (const name of ["Dashboard", "Inbox", "Messages", "Agents", "Usage and costs", "Extensions", "All projects", "Settings"]) {
      expect(rail?.querySelector(`button[aria-label="${name}"]`), name).not.toBeNull();
    }
    expect(rail?.querySelector('button[title="trantor"]')).not.toBeNull();
    expect(host.querySelector('footer[aria-label="Plans and balances"]')).not.toBeNull();
    expect(host.querySelector('[role="group"][aria-label="Mode"]')).not.toBeNull();
  });

  it("routes each fleet screen to its own heading", async () => {
    await mount();
    const cases: [string, string][] = [["Inbox", "Inbox"], ["Agents", "Agents"], ["Usage and costs", "Usage and costs"],
      ["Extensions", "Extensions and tools"], ["Settings", "Settings"], ["All projects", "All projects"]];
    for (const [label, title] of cases) {
      await click(`nav button[aria-label="${label}"]`);
      expect(heading(), label).toBe(title);
    }
  });

  it("frames project screens with the header and the seven lens tabs", async () => {
    await mount();
    await click('nav button[title="trantor"]');
    expect(host.querySelector("main")?.getAttribute("data-screen")).toBe("workspace");
    const tabs = [...host.querySelectorAll('[role="tablist"][aria-label="Lenses"] [role="tab"]')].map(t => t.textContent?.replace(/\d+$/, ""));
    expect(tabs).toEqual(["Workspace", "Code", "Graph", "Board", "Feed", "Bus", "Browser"]);
    await click('[role="tab"]:nth-child(4)');
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Board");
    expect(host.querySelector("main")?.getAttribute("data-screen")).toBe("board");
  });

  it("offers Back to classic in the account menu", async () => {
    await mount();
    await click('button[aria-label="Account: sasha"]');
    const item = [...host.querySelectorAll('[role="menu"] [role="menuitem"]')].find(b => b.textContent === "Back to classic");
    expect(item).toBeDefined();
  });
});

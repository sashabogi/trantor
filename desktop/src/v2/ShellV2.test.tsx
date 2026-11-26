// @vitest-environment happy-dom
// #v2-F: the shell mounts on the real client calls, routes every rail entry, frames project
// screens with the lens tabs, and offers Back to classic.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { ShellV2, LensScreenView } from "./ShellV2";
import { ONBOARDING_REOPENED } from "../features/onboarding/onboardingApi";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// One empty body that satisfies every list endpoint the shell polls.
const EMPTY = JSON.stringify({ peers: [], messages: [], cursor: 0, tasks: [], proposals: [], holds: [], entries: [], machines: [], ts: Date.now(), staleAfterMs: 90_000 });

const overrides = new Map<string, unknown>();
const calls: string[] = [];
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  overrides.clear(); calls.length = 0;
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
  mockIPC(command => {
    calls.push(command);
    if (overrides.has(command)) return overrides.get(command);
    if (command === "known_projects") return ["crebral-cortex", "trantor"];
    if (command === "hub_for_project") return "http://127.0.0.1:4477";
    if (command === "identity_name") return "sasha";
    // #13987 drill: the chat column now always mounts Chat, which polls handoff state.
    if (command === "handoff_states") return [];
    if (command === "local_sessions") return [{ project: "trantor", status: "working" }];
    if (command === "hub_request") return { status: 200, body: EMPTY };
    if (command === "plugin:event|listen") return 1;
    return null;
  }, { shouldMockEvents: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
// The unmount is awaited so Chat's event unlisten settles before the mocks are cleared.
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); clearMocks(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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

  it("frames project screens with the header and the six lens tabs", async () => {
    await mount();
    await click('nav button[title="trantor"]');
    expect(host.querySelector("main")?.getAttribute("data-screen")).toBe("workspace");
    const tabs = [...host.querySelectorAll('[role="tablist"][aria-label="Lenses"] [role="tab"]')].map(t => t.textContent?.replace(/\d+$/, ""));
    expect(tabs).toEqual(["Workspace", "Code", "Graph", "Board", "Feed", "Bus"]);
    await click('[role="tab"]:nth-child(4)');
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Board");
    expect(host.querySelector("main")?.getAttribute("data-screen")).toBe("board");
  });

  // #14070: the mode switch was a dead control; it now moves the project on screen and reorders the tabs.
  it("opens the project on Code in Developer mode and goes back in Orchestrator", async () => {
    await mount();
    await click('nav button[title="trantor"]');
    const mode = (name: string) => [...host.querySelectorAll<HTMLElement>('[role="group"][aria-label="Mode"] button')].find(b => b.textContent === name);
    const tabs = () => [...host.querySelectorAll('[role="tablist"][aria-label="Lenses"] [role="tab"]')].map(t => t.textContent?.replace(/\d+$/, ""));
    await act(async () => { mode("Developer")?.click(); });
    expect(host.querySelector("main")?.getAttribute("data-screen")).toBe("code");
    expect(tabs()[0]).toBe("Code");
    expect(host.querySelector("main h1")).toBeNull();
    expect(mode("Developer")?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => { mode("Mixed")?.click(); });
    expect(mode("Mixed")?.getAttribute("aria-disabled")).toBe("true");
    expect(mode("Mixed")?.getAttribute("title")).toContain("Mixed mode comes next");
    expect(mode("Developer")?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => { mode("Orchestrator")?.click(); });
    expect(host.querySelector("main")?.getAttribute("data-screen")).toBe("workspace");
    expect(tabs()).toEqual(["Workspace", "Code", "Graph", "Board", "Feed", "Bus"]);
    expect(host.querySelector("main h1")?.textContent).toBe("trantor");
  });

  it("offers Back to classic in the account menu", async () => {
    await mount();
    await click('button[aria-label="Account: sasha"]');
    const item = [...host.querySelectorAll('[role="menu"] [role="menuitem"]')].find(b => b.textContent === "Back to classic");
    expect(item).toBeDefined();
  });

  // #14322: the 2.0 shell mounts the first-run gate, the CLI banner and the local hub start.
  const OPEN = JSON.stringify({ flowVersion: 1, closedAt: null, lastCompletedStep: null });
  const CLOSED = JSON.stringify({ flowVersion: 1, closedAt: 1, lastCompletedStep: null });
  const SETUP_GAP = { node: "v22.0.0", npm: true, trantor: null, trantorCompatible: false, trantorMinimum: "0.18.47", herdr: null };

  it("mounts the onboarding wizard on its setup step when onboarding is open", async () => {
    overrides.set("onboarding_get", OPEN);
    overrides.set("setup_check", SETUP_GAP);
    await mount();
    expect(host.querySelector('[data-testid="wizard-frame"]')?.textContent).toContain("Check your setup");
    expect(host.querySelector('[data-setup-row="trantor"]')?.getAttribute("data-status")).toBe("missing");
  });

  it("does not mount the wizard once onboarding is closed", async () => {
    overrides.set("onboarding_get", CLOSED);
    await mount();
    expect(host.querySelector('[data-testid="wizard-frame"]')).toBeNull();
  });

  it("Show onboarding again from Settings reopens the wizard in 2.0", async () => {
    overrides.set("onboarding_get", CLOSED);
    overrides.set("setup_check", { ...SETUP_GAP, trantor: "0.18.99", trantorCompatible: true, herdr: "/bin/herdr" });
    await mount();
    expect(host.querySelector('[data-testid="wizard-frame"]')).toBeNull();
    overrides.set("onboarding_get", OPEN);
    await act(async () => { window.dispatchEvent(new Event(ONBOARDING_REOPENED)); });
    expect(host.querySelector('[data-testid="wizard-frame"]')?.textContent).toContain("Check your setup");
  });

  it("shows the too-old CLI banner", async () => {
    overrides.set("trantor_cli_compatibility", { installed: "0.1.0", minimum: "0.18.47", compatible: false, reason: "trantor CLI 0.1.0 is older than this app needs" });
    await mount();
    expect(host.querySelector("[data-trantor-cli-banner]")?.textContent).toContain("older than this app needs");
  });

  it("starts the local hub once at mount and shows it running", async () => {
    overrides.set("local_hub_ensure", { state: "started", detail: null, logPath: "/h/hub.log" });
    await mount();
    expect(calls.filter(c => c === "local_hub_ensure")).toHaveLength(1);
    expect(host.querySelector("[data-local-hub]")?.textContent).toBe("Local hub running");
  });

  it("a failed hub start names the log and Retry starts it again", async () => {
    overrides.set("local_hub_ensure", { state: "failed", detail: "boom", logPath: "/h/hub.log" });
    await mount();
    expect(host.querySelector("[data-local-hub]")?.textContent).toContain("/h/hub.log");
    await click("[data-local-hub] button");
    expect(calls.filter(c => c === "local_hub_ensure")).toHaveLength(2);
  });

  it("with no projects a lens offers Start a project, not a CLI instruction", async () => {
    const onStartProject = vi.fn();
    // SAFETY: LensScreenView returns before reading client or project fields when no project is set.
    const props = { client: {}, project: null, onNavigate: vi.fn(), onStartProject } as never;
    await act(async () => { root.render(<LensScreenView screen="workspace" props={props} me="m" />); });
    expect(host.textContent).toContain("No projects yet.");
    expect(host.textContent).not.toContain("trantor hub set");
    await click("button");
    expect(onStartProject).toHaveBeenCalledOnce();
  });
});

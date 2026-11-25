// @vitest-environment happy-dom
// #13992: the screen mounts on real client calls and shows seats, honest disabled actions, and the Overseer column.
// #14050: seat actions run through the Workspace's useCrew; controls with nothing behind them are gone.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { HubClient } from "../../../shared/api/client";
import { AgentsScreen } from "./index";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = Date.now();
const PEERS = { peers: [
  { session: "codex-8", project: "trantor", lastSeen: now - 5_000, model: "gpt-x", machine: "netcup" },
  { session: "kimi-9", project: "trantor", lastSeen: now - 120_000 },
  { session: "glm-5", project: "other", lastSeen: now - 5_000 },
] };
const OVERSEER = { engine: true, lastTickTs: now - 2_000, tickMs: 30_000, clearMs: 1, dutySession: "claude:trantor-duty",
  watching: { sessions: 3, projects: 2, claims: 0, links: 0 }, autonomy: { trantor: 2 }, links: [], warnings: [], standing: 0 };
const EMPTY = { tasks: [], proposals: [], holds: [], entries: [], machines: [], events: [], ts: now, staleAfterMs: 90_000 };

// The crew catalog the CLI serves: two installed, enabled agents with quota.
type CliOutcome = { ok: boolean; reason?: string };
const SETTINGS = JSON.stringify({ default: "codex", agents: [
  { id: "codex", label: "Codex", launch: "codex", cli: "codex", installed: true, enabled: true, isDefault: true, homepage: "https://codex", install: "npm i -g codex" },
  { id: "kimi", label: "Kimi", launch: "kimi", cli: "kimi", installed: true, enabled: true, isDefault: false, homepage: "https://kimi", install: "npm i -g kimi" },
] });
const BALANCES = JSON.stringify({ balances: [] });
const WHY = JSON.stringify({ state: "stopped", why: "PARKED (window closed)", advice: "trantor up" });

function bodyFor(path: string) {
  if (path === "/peers") return PEERS;
  if (path === "/overseer/status") return OVERSEER;
  return EMPTY;
}

let cliCalls: { project: string; args: string[] }[];
let crewResult: CliOutcome;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  cliCalls = [];
  crewResult = { ok: true };
  mockIPC((command, args) => {
    if (command === "hub_request") {
      // SAFETY: hub_request args are { base, method, path, body } by the HubClient transport contract.
      const path = String((args as { path: string }).path).split("?")[0];
      return { status: 200, body: JSON.stringify(bodyFor(path)) };
    }
    if (command === "workspace_cli") {
      // SAFETY: workspace_cli is invoked with { project, args } by the crew control bridge.
      const { project, args: argv } = args as { project: string; args: string[] };
      cliCalls.push({ project, args: argv });
      if (argv[0] === "agent-settings") return SETTINGS;
      if (argv[0] === "balances") return BALANCES;
      if (argv[0] === "seat-why") return WHY;
      return JSON.stringify({ ok: crewResult.ok, action: argv[0], seat: argv[1] ?? "", reason: crewResult.reason });
    }
    if (command === "plugin:event|listen") return 1;
    return null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); vi.restoreAllMocks(); });

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 50)); });
const mount = async (onNavigate = vi.fn()) => {
  await act(async () => { root.render(<AgentsScreen client={new HubClient("http://hub.test")} project="trantor" onNavigate={onNavigate} />); });
  await settle();
  return onNavigate;
};
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const textButton = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text);
const pick = async (triggerText: string, menuLabel: string, item: string) => {
  await act(async () => { textButton(triggerText)?.click(); });
  const entries = [...host.querySelectorAll<HTMLElement>(`[role="menu"][aria-label="${menuLabel}"] [role="menuitem"]`)];
  await act(async () => { entries.find(e => e.textContent?.startsWith(item))?.click(); });
  await settle();
};

describe("AgentsScreen", () => {
  it("lists this project's seats, sorted, with titled icon actions and the Overseer column", async () => {
    const onNavigate = await mount();
    // working codex-8 sorts before ready kimi-9; glm-5 lives in another project so it is not on the roster
    expect([...host.querySelectorAll("article")].map(a => a.getAttribute("aria-label"))).toEqual(["codex-8", "kimi-9"]);
    for (const b of host.querySelectorAll<HTMLButtonElement>("article button[aria-label]")) expect(b.title).not.toBe("");
    expect(host.querySelector('[aria-label="Autonomy ladder"]')).not.toBeNull();
    expect(host.textContent).toContain("trantor-duty");
    act(() => { host.querySelector<HTMLElement>('[aria-label="Open its terminal"]')?.click(); });
    expect(onNavigate).toHaveBeenCalledWith("workspace", "trantor");
  });

  it("Add seat opens the Workspace picker and starts the chosen agent through the crew CLI", async () => {
    await mount();
    await pick("Add seat", "Add a seat", "Kimi");
    expect(cliCalls).toContainEqual({ project: "trantor", args: ["up", "kimi", "--json"] });
    expect(host.querySelector('[role="status"]')?.textContent).toContain("kimi · done");
  });

  it("Start seat in the roster panel opens the same picker for the project on screen", async () => {
    await mount();
    await pick("Start seat", "Add a seat", "Codex");
    expect(cliCalls).toContainEqual({ project: "trantor", args: ["up", "codex", "--json"] });
  });

  it("swaps a crew seat through the crew CLI; crew seats get no Restart, only the duty seat does", async () => {
    await mount();
    await act(async () => { button("Swap codex-8")?.click(); });
    const items = [...host.querySelectorAll<HTMLElement>('[role="menu"][aria-label="Swap codex-8 to"] [role="menuitem"]')];
    await act(async () => { items.find(e => e.textContent?.startsWith("Kimi"))?.click(); });
    await settle();
    expect(cliCalls).toContainEqual({ project: "trantor", args: ["swap", "codex-8", "kimi", "--json"] });
    // crew.start takes a catalog id, not a seat's instance name, so a stop-then-start restart is gone from crew seats
    expect(button("Restart codex-8")).toBeNull();
    expect(button("Restart kimi-9")).toBeNull();
    expect(cliCalls).not.toContainEqual({ project: "trantor", args: ["down", "codex-8", "--json"] });
  });

  it("a failed seat action shows its real error on the card that acted", async () => {
    await mount();
    crewResult = { ok: false, reason: "no runner for codex-8" };
    await act(async () => { button("Stop codex-8")?.click(); });
    await settle();
    const card = host.querySelector('article[aria-label="codex-8"]');
    expect(card?.querySelector('[role="status"]')?.textContent).toContain("codex-8 · no runner for codex-8");
  });

  it("no control is a 'not wired' stub: Advisor, Trust rules, History, Hand off and the CLI line are gone", async () => {
    await mount();
    expect(textButton("Ask the Advisor")).toBeUndefined();
    expect(host.textContent).not.toContain("Seats start from the trantor CLI");
    expect([...host.querySelectorAll('[role="tablist"] button')].map(b => b.textContent))
      .toEqual(["Roster", "Overseer", "Harnesses and models"]);
    for (const b of host.querySelectorAll<HTMLButtonElement>("button")) {
      expect(b.getAttribute("title") ?? "").not.toContain("not wired");
      expect(b.getAttribute("title") ?? "").not.toContain("trantor CLI");
    }
    for (const a of host.querySelectorAll("article")) expect(a.textContent).not.toContain("Hand off");
    // seats in another project get no crew buttons: their actions would run against the wrong project
    await act(async () => { textButton("All projects")?.click(); });
    await settle();
    expect(button("Swap glm-5")).toBeNull();
    expect(button("Stop glm-5")).toBeNull();
    expect(button("Restart glm-5")).toBeNull();
  });
});

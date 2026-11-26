// @vitest-environment happy-dom
// #13987: the Workspace reads real peers, selection drives the inspector, and every send goes the classic way.
// Fakes sit at the boundaries only: the hub transport, the Tauri IPC, and the two heavy panes injected through panes.tsx.
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { HubClient, type FileHold, type Peer } from "../../../shared/api/client";
import type { Composer } from "../../../features/chat/Composer";
import { surfaceFor, type HerdrSeat } from "../../../features/workspace/herdr";
import type { PaneTarget } from "../../../features/workspace/paneTargets";
import { closeCardSheet, currentCardSheet } from "../../shell/cardIntent";
import { takeOpenIntent } from "../../shell/openIntent";
import { WorkspaceScreen } from "./index";
import { ComposerAdapter, judge } from "./ComposerAdapter";
import { DEFAULT_PANES, WorkspacePanesContext, type WorkspacePanes } from "./panes";
import { gridColumns, takesSeatMessage, visibleSeats, type SeatView } from "./seatModel";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PANES: WorkspacePanes = {
  TerminalPane: ({ agent }) => <div data-testid="terminal" data-agent={agent} />,
  RightPanel: () => <aside aria-label="Project panel" />,
};
const withPanes = (node: ReactNode) => <WorkspacePanesContext.Provider value={{ ...DEFAULT_PANES, ...PANES }}>{node}</WorkspacePanesContext.Provider>;

const now = Date.now();
const PEERS: Peer[] = [
  { session: "codex-8:trantor", project: "trantor", online: true, lastSeen: now, status: "working · card 13970", kind: "agent", llm: "codex" },
  { session: "glm-5:trantor", project: "trantor", online: true, lastSeen: now, status: "idle", kind: "agent", llm: "glm" },
  { session: "deepseek:trantor", project: "trantor", online: false, lastSeen: now - 2 * 3600_000, kind: "agent", llm: "deepseek" },
  { session: "MacBook-Pro:trantor", project: "trantor", online: true, lastSeen: now },
  { session: "kimi-9:other", project: "other", online: true, lastSeen: now, kind: "agent" },
];
// The crew catalog the CLI serves: three installed, enabled agents with quota.
const CREW = JSON.stringify({ agents: [
  { id: "codex", label: "Codex", launch: "codex", cli: "codex", installed: true, enabled: true, isDefault: true, homepage: "https://codex", install: "npm i -g codex" },
  { id: "kimi", label: "Kimi", launch: "kimi", cli: "kimi", installed: true, enabled: true, isDefault: false, homepage: "https://kimi", install: "npm i -g kimi" },
  { id: "glm", label: "GLM", launch: "glm:zai-coding-plan", cli: "opencode", installed: true, enabled: true, isDefault: false, homepage: "https://glm", install: "npm i -g opencode" },
], balances: [] });
const CARDS = [{ id: 13970, project: "trantor", title: "Restore at login", status: "doing", assignee: "codex-8:trantor" }];
const HOLD: FileHold = { id: 7, project: "trantor", file: "src/a.ts", session: "codex-8:trantor", other: "glm-5:trantor", status: "pending", ts: now };

type HubReply = { peers: Peer[] } | { tasks: typeof CARDS } | { holds: FileHold[] } | { ok: boolean; id: number };
type Calls ={ path: string; method: string; body: string | null }[];
function fakeClient(calls: Calls, holds: FileHold[] = []) {
  return new HubClient("http://hub.test", async ({ method, path, body }) => {
    calls.push({ path, method, body });
    const json = (reply: HubReply) => ({ status: 200, body: JSON.stringify(reply) });
    if (path.startsWith("/peers")) return json({ peers: PEERS });
    if (path.startsWith("/tasks")) return json({ tasks: CARDS });
    if (path.startsWith("/holds")) return json({ holds });
    return json({ ok: true, id: 1 });
  });
}

let host: HTMLDivElement;
let root: Root;
let ipc: { command: string; args: unknown }[];
let localPanes: HerdrSeat[];
beforeEach(() => {
  ipc = [];
  localPanes = [];
  mockIPC((command, args) => {
    ipc.push({ command, args });
    if (command === "herdr_seats") return JSON.stringify(localPanes);
    if (command === "identity_name") return "sasha";
    if (command === "autonomy_get") return JSON.stringify({ resolved: { harness: "prompt", push: false, commit: true } });
    if (command === "git_panel") return JSON.stringify({ branch: "seat/codex-8", upstream: null, ahead: 1, behind: null, status: [], counts: [], log: [] });
    if (command === "seat_diff") return JSON.stringify({ branch: "seat/codex-8", base: "main", files: [{ path: "a.ts", plus: 3, minus: 1, untracked: false }], patch: "" });
    if (command === "pane_send") return { outcome: "delivered", error: null };
    if (command === "workspace_cli") {
      // SAFETY: workspace_cli is invoked with { project, args } by the crew control bridge.
      const argv = (args as { project: string; args: string[] }).args;
      if (argv[0] === "helper" && argv[1] === "stop") localPanes = localPanes.filter(p => p.surface !== argv[2]);
      return argv[0] === "agent-settings" || argv[0] === "balances" ? CREW : JSON.stringify({ ok: true, action: argv[0], seat: argv[1] ?? "" });
    }
    if (command === "plugin:event|listen") return 1;
    return null;
  });
  // #14030: a fresh store per test. The Workspace persists the picked seat and layout, which leaked between
  // tests where the runtime has a real localStorage, and a bare localStorage does not exist where it has none.
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const mountScreen = async (client: HubClient, onNavigate: ComponentProps<typeof WorkspaceScreen>["onNavigate"] = () => {}) => {
  await act(async () => { root.render(withPanes(<WorkspaceScreen client={client} project="trantor" onNavigate={onNavigate} />)); });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
};
const click = (el: Element | null) => act(async () => { if (el instanceof HTMLElement) el.click(); });
const typeInto = (el: HTMLInputElement | HTMLTextAreaElement | null, text: string) => act(async () => {
  if (!el) throw new Error("no field to type into");
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
// #14241: seats render as role=tab joined to the pane below, so the strip's queries find tabs.
// #14365: crew tabs are icon-only, named by aria-label; helper tabs still carry their text.
const tabText = (b: Element | null | undefined) => `${b?.getAttribute("aria-label") ?? ""}${b?.textContent ?? ""}`;
const chipFor = (name: string) => [...host.querySelectorAll('[role="tab"]')].find(b => tabText(b).includes(name)) ?? null;
const terminalAgents = () => [...host.querySelectorAll("[data-testid=terminal]")].map(t => t.getAttribute("data-agent"));

describe("seat strip", () => {
  it("activates Workspace panes and reflects each focused or tiled seat's working state", async () => {
    await mountScreen(fakeClient([]));
    const terminal = host.querySelector('[data-testid="terminal"]');
    const work = terminal?.closest("[data-v2-pane]");
    expect(work?.getAttribute("data-working")).toBe("true");
    await act(async () => terminal?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    expect(work?.getAttribute("data-active")).toBe("true");
    const chat = host.querySelector('aside[aria-label="Chat column"] [data-v2-pane]');
    expect(chat).not.toBeNull();
    await act(async () => chat?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    expect(work?.hasAttribute("data-active")).toBe(false);
    expect(chat?.getAttribute("data-active")).toBe("true");
    expect(host.querySelector('aside[aria-label="Files rail"]')?.hasAttribute("data-v2-pane")).toBe(true);
    await click(host.querySelector('button[aria-label="Open files"]'));
    expect(host.querySelector('aside[aria-label="Source control"] [data-v2-pane]')).not.toBeNull();
    await click(chipFor("glm-5"));
    expect(work?.hasAttribute("data-working")).toBe(false);
    await click(host.querySelector('[role="group"][aria-label="Layout"] button[title="Grid: every seat"]'));
    const tiles = [...host.querySelectorAll('[data-testid="terminal"]')].map(t => t.closest("[data-v2-pane]"));
    expect(tiles.map(t => t?.hasAttribute("data-working"))).toEqual([true, false]);
    await act(async () => tiles[0]?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    expect(host.querySelectorAll("[data-v2-pane][data-active]")).toHaveLength(1);
    expect(tiles[0]?.getAttribute("data-active")).toBe("true");
  });

  it("shows a tab per live seat of this project, the offline count and the add button (#14241)", async () => {
    await mountScreen(fakeClient([]));
    expect(host.querySelectorAll('[role="tablist"][aria-label="Seats"] [role="tab"]')).toHaveLength(2);
    expect(tabText(chipFor("codex-8"))).toContain("working on card 13970");
    expect(tabText(chipFor("glm-5"))).toContain("ready");
    // #14351: the "N seats live" counter is gone; the tabs already show it.
    expect(host.textContent).not.toContain("seats live");
    expect(chipFor("kimi-9")).toBeNull();
    expect(chipFor("MacBook")).toBeNull();
    expect(host.textContent).toContain("+1 offline");
    expect(host.querySelector('button[aria-label="Add a seat"]')).not.toBeNull();
    expect(host.querySelector('[role="group"][aria-label="Layout"]')).not.toBeNull();
  });
});

// #14264: helpers have terminal tabs and pane controls without acquiring crew identities.
describe("helper panes", () => {
  it("shows helpers after crew, excludes them from the count and messages, and stops by pane", async () => {
    localPanes = [
      { project: "trantor", kind: "helper", agent: "review", surface: "w1:p2", status: "working" },
      { project: "trantor", kind: "helper", agent: "review", surface: "w1:p3", status: "idle" },
      { project: "other", kind: "helper", agent: "hidden", surface: "w2:p1", status: "working" },
    ];
    await mountScreen(fakeClient([]));
    const tabs = [...host.querySelectorAll('[role="tablist"][aria-label="Seats"] [role="tab"]')];
    expect(tabs.map(t => t.getAttribute("aria-label"))).toEqual([expect.stringContaining("codex-8, working on card 13970"), expect.stringContaining("glm-5, ready"), expect.stringMatching(/^review \(helper\), /), expect.stringMatching(/^review \(helper\), /)]);
    // #14365: helpers are astronauts too, with no name text in the tab; with no known vendor the visor wears a prompt
    expect(tabs[2].textContent).toBe("›_");
    expect(tabs[2].querySelector('[data-variant="full"]')).not.toBeNull();
    await click(tabs[2]);
    expect(terminalAgents()).toEqual(["helper:w1:p2"]);
    expect(host.querySelector('input[placeholder*="Message"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Send to review"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Message review"]')).toBeNull();
    expect(await surfaceFor("trantor", "helper:w1:p2")).toEqual({ surface: "w1:p2", machine: null });
    expect(await surfaceFor("trantor", "helper:w1:p3")).toEqual({ surface: "w1:p3", machine: null });
    await click(host.querySelector('button[aria-label="Stop review"]'));
    expect(ipc).toContainEqual({ command: "workspace_cli", args: { project: "trantor", args: ["helper", "stop", "w1:p2", "--json"] } });
    expect(host.querySelectorAll('button[aria-label="Stop review"]')).toHaveLength(1);
    expect(host.textContent).not.toContain("reviewrunninghelper");
  });

  it("includes helper terminals in Split and Grid", async () => {
    localPanes = [{ project: "trantor", kind: "helper", agent: "check", surface: "w1:p4", status: "working" }];
    await mountScreen(fakeClient([]));
    await click(chipFor("check"));
    await click(host.querySelector('[role="group"][aria-label="Layout"] button[aria-label="Split"]'));
    expect(terminalAgents()).toEqual(["helper:w1:p4", "codex-8"]);
    await click(host.querySelector('[role="group"][aria-label="Layout"] button[aria-label="Grid"]'));
    expect(terminalAgents()).toEqual(["codex-8", "glm-5", "helper:w1:p4"]);
    expect(takesSeatMessage({ isOrchestrator: false, isHelper: true })).toBe(false);
  });
});

describe("selection and inspector", () => {
  it("selecting a seat swaps the inspector, the terminal and the card chip", async () => {
    await mountScreen(fakeClient([]));
    expect(terminalAgents()).toEqual(["codex-8"]);
    expect(host.querySelector('button[aria-label="Message codex-8"]')).not.toBeNull();
    expect(host.textContent).toContain("#13970");
    expect(host.textContent).toContain("seat/codex-8 ↑1");
    // #14351: the project-wide autonomy chip, hub status and "context not reported" left the seat bar for the hover card.
    expect(host.textContent).not.toContain("New sessions: asks first");
    expect(host.textContent).not.toContain("context not reported");
    await click(chipFor("glm-5"));
    expect(terminalAgents()).toEqual(["glm-5"]);
    expect(host.querySelector('button[aria-label="Message glm-5"]')).not.toBeNull();
    expect(host.textContent).not.toContain("#13970");
  });

  it("Grid shows every live seat's terminal and a header click focuses that seat", async () => {
    await mountScreen(fakeClient([]));
    await click(host.querySelector('[role="group"][aria-label="Layout"] button[title="Grid: every seat"]'));
    expect(terminalAgents()).toEqual(["codex-8", "glm-5"]);
    await click(host.querySelector('button[title="Open glm-5 full size"]'));
    expect(terminalAgents()).toEqual(["glm-5"]);
  });

  it("Grid tile headers wear the compact astronaut at 24px beside the name and activity (#14365)", async () => {
    await mountScreen(fakeClient([]));
    await click(host.querySelector('[role="group"][aria-label="Layout"] button[title="Grid: every seat"]'));
    const head = host.querySelector('button[title="Open codex-8 full size"]');
    const astro = head?.querySelector<HTMLElement>('[data-variant="compact"]');
    expect(astro?.getAttribute("aria-label")).toBe("codex-8, working");
    expect(astro?.style.getPropertyValue("--s")).toBe("24px");
    expect(head?.textContent).toContain("codex-8");
    expect(head?.textContent).toContain("working on card 13970");
    expect(head?.querySelectorAll('[role="img"]')).toHaveLength(1);
  });

  it("opens the worktree in Code through onNavigate", async () => {
    const go = vi.fn();
    await mountScreen(fakeClient([]), go);
    await click(host.querySelector('button[aria-label="Open codex-8\'s worktree in Code"]'));
    expect(go).toHaveBeenCalledWith("code");
    // #14351: the button carries a scope intent for THIS seat's worktree.
    expect(takeOpenIntent("trantor")).toEqual({ kind: "source-control", seat: "codex-8" });
  });

  it("Swap on a seat offers every agent but its own: no GLM row on glm-5, and the CLI swaps the seat (#14062)", async () => {
    await mountScreen(fakeClient([]));
    await click(chipFor("glm-5"));
    await click(host.querySelector('button[aria-label="More actions for glm-5"]'));
    await click([...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(e => e.textContent === "Swap agent") ?? null);
    const items = [...host.querySelectorAll<HTMLElement>('[role="menu"][aria-label="Swap glm-5 to"] [role="menuitem"]')];
    expect(items.some(e => e.textContent?.startsWith("GLM"))).toBe(false);
    expect(items.some(e => e.textContent?.startsWith("Kimi"))).toBe(true);
    await act(async () => { items.find(e => e.textContent?.startsWith("Kimi"))?.click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    // SAFETY: ipc records every Tauri call as { command, args }; the crew bridge sends { project, args }.
    const swap = ipc.filter(c => c.command === "workspace_cli").map(c => (c.args as { project: string; args: string[] }).args).find(a => a[0] === "swap");
    expect(swap).toEqual(["swap", "glm-5", "kimi", "--json"]);
  });
});

describe("middle column (#14351)", () => {
  // SAFETY: ipc records every Tauri call as { command, args }; the crew bridge sends { project, args }.
  const stopped = () => ipc.some(c => c.command === "workspace_cli" && (c.args as { args: string[] }).args[0] === "down");
  const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

  it("draws icon-only crew tabs with the full-body astronaut and merges the active one into the pane (#14365)", async () => {
    await mountScreen(fakeClient([]));
    const codex = chipFor("codex-8");
    // Just the astronaut: no name or activity text, no separate state dot, the name rides on the aria-label.
    expect(codex?.textContent).toBe("");
    expect(codex?.querySelectorAll("span.truncate")).toHaveLength(0);
    expect(codex?.getAttribute("aria-label")).toBe("codex-8, working on card 13970");
    // The operator: tall tabs with the whole animated astronaut (typing, tapping, waving), not just the head.
    expect(codex?.querySelector('[data-variant="full"]')?.getAttribute("aria-label")).toBe("codex-8, working");
    expect(codex?.querySelector('[data-variant="compact"]')).toBeNull();
    expect(codex?.querySelectorAll('[role="img"]')).toHaveLength(1);
    expect(codex?.parentElement?.getAttribute("data-active")).toBe("true");
    expect(codex?.parentElement?.className).toContain("border-t-[var(--v2-accent)]");
    expect(codex?.parentElement?.style.width).toBe("76px");
    expect(chipFor("glm-5")?.parentElement?.getAttribute("data-active")).toBeNull();
  });

  // Operator: "the top of the tab that's colored actually matches their branding color ... so they can be
  // easily distinguishable." Full brand colour on the active tab, the same colour softened on the rest.
  it("gives every crew tab a top edge in its own brand colour (#14365)", async () => {
    await mountScreen(fakeClient([]));
    const top = (name: string) => chipFor(name)?.parentElement?.style.borderTopColor ?? "";
    expect(top("codex-8").toLowerCase()).toMatch(/^(#7a9dff|rgb\(122, 157, 255\))$/);
    // inactive: the same brand colour at ~70% (#5ea0f5 + alpha 0xb3)
    expect(top("glm-5").toLowerCase()).toMatch(/^(#5ea0f5b3|rgba\(94, 160, 245, 0\.70?\d*\))$/);
    expect(top("glm-5")).not.toBe(top("codex-8"));
  });

  it("puts the hold on the tab: needs you overrides and says what", async () => {
    await mountScreen(fakeClient([], [HOLD]));
    expect(tabText(chipFor("codex-8"))).toContain("needs you: approve edit a.ts");
    expect(chipFor("codex-8")?.querySelector('[data-state="needs"]')).not.toBeNull();
  });

  it("shows the hover card after a rest, with a row only where the seat has something to say", async () => {
    await mountScreen(fakeClient([]));
    const tab = chipFor("codex-8")?.parentElement;
    await act(async () => { tab?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })); });
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
    await wait(450);
    const card = host.querySelector('[role="tooltip"]');
    expect(card).not.toBeNull();
    const rows = [...(card?.querySelectorAll("[data-row]") ?? [])].map(r => r.getAttribute("data-row"));
    expect(rows).toEqual(["Doing", "Branch", "Changes", "May do"]);
    expect(card?.textContent).toContain("+3");
    expect(card?.textContent).toContain("asks first");
    expect(card?.className).toContain("pointer-events-none");
    // #14365: the card head is the full astronaut scene at 48px beside the seat's name and state.
    const scene = card?.querySelector<HTMLElement>('[data-variant="full"]');
    expect(scene?.getAttribute("aria-label")).toBe("codex-8, working");
    expect(scene?.style.getPropertyValue("--s")).toBe("48px");
    expect(card?.textContent).toContain("codex-8");
    await act(async () => { tab?.dispatchEvent(new MouseEvent("pointerout", { bubbles: true })); });
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
    // glm-5 has no card and no worktree facts in this fixture beyond the branch: no Doing row.
    const glm = chipFor("glm-5")?.parentElement;
    await act(async () => { glm?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })); });
    await wait(450);
    expect([...host.querySelectorAll('[role="tooltip"] [data-row]')].map(r => r.getAttribute("data-row"))).not.toContain("Doing");
  });

  it("keeps Drill mode in the strip's ... menu and no Record button", async () => {
    await mountScreen(fakeClient([]));
    expect([...host.querySelectorAll("button")].some(b => b.textContent === "Record")).toBe(false);
    await click(host.querySelector('button[aria-label="More strip actions"]'));
    const items = [...host.querySelectorAll<HTMLElement>('[role="menu"][aria-label="Strip actions"] [role="menuitem"]')];
    expect(items.map(i => i.textContent)).toEqual(["Drill mode", "Preview seat states", "All seats"]);
    await act(async () => { items[0].click(); });
    await wait(10);
    expect(host.textContent).toContain("Drill Mode");
  });

  // #14365: the operator wanted to watch every state play; the preview walks the tabs through them,
  // staggered so several show at once, without touching any agent, and stops on demand.
  it("Preview seat states walks the tabs through the states and Stop puts them back", async () => {
    await mountScreen(fakeClient([]));
    const states = () => [...host.querySelectorAll('[role="tablist"][aria-label="Seats"] [role="tab"] [data-variant="full"]')].map(e => e.getAttribute("data-state"));
    const before = states();
    await click(host.querySelector('button[aria-label="More strip actions"]'));
    const item = [...host.querySelectorAll<HTMLElement>('[role="menu"][aria-label="Strip actions"] [role="menuitem"]')].find(i => i.textContent === "Preview seat states");
    await act(async () => { item?.click(); });
    const during = states();
    expect(during[0]).toBe("working");
    expect(during[1]).toBe("waiting");
    expect(host.textContent).toContain("Previewing · Stop");
    await click([...host.querySelectorAll("button")].find(b => b.textContent?.includes("Previewing · Stop")) ?? null);
    expect(states()).toEqual(before);
    expect(host.textContent).not.toContain("Previewing · Stop");
  });

  it("the seat bar replaces the inspector: view tabs, card link, Message focuses the input, no disabled hand off", async () => {
    await mountScreen(fakeClient([]));
    const views = [...host.querySelectorAll('[role="tablist"][aria-label="Seat views"] [role="tab"]')];
    expect(views.map(v => v.textContent)).toEqual(["Terminal", "Changes1"]);
    expect(host.querySelector('button[aria-label="Hand off codex-8\'s session"]')).toBeNull();
    expect(host.textContent).not.toContain("Hand off");
    await click(host.querySelector('button[title="Open the card"]'));
    expect(currentCardSheet()).toEqual({ project: "trantor", id: 13970 });
    closeCardSheet();
    await click(host.querySelector('button[aria-label="Message codex-8"]'));
    await act(async () => { await new Promise(r => requestAnimationFrame(() => r(null))); });
    expect(document.activeElement?.id).toBe("v2-seatmsg");
    expect(host.querySelector<HTMLInputElement>("input#v2-seatmsg")?.placeholder).toBe("Message codex-8 at its next turn");
  });

  it("Stop seat asks for confirmation before the crew stops it", async () => {
    await mountScreen(fakeClient([]));
    await click(host.querySelector('button[aria-label="More actions for codex-8"]'));
    await click([...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(e => e.textContent === "Stop seat") ?? null);
    expect(stopped()).toBe(false);
    await click([...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(e => e.textContent === "Stop codex-8") ?? null);
    await wait(20);
    expect(stopped()).toBe(true);
  });

  it("tiles carry the terminal ground, the needs-you edge and a header that names the activity", async () => {
    await mountScreen(fakeClient([], [HOLD]));
    await click(host.querySelector('[role="group"][aria-label="Layout"] button[aria-label="Grid"]'));
    const tiles = [...host.querySelectorAll<HTMLElement>("[data-v2-pane]")].filter(t => t.className.includes("group/tile"));
    expect(tiles.length).toBe(2);
    expect(tiles.every(t => t.className.includes("bg-[var(--v2-terminal)]") && t.className.includes("rounded-lg"))).toBe(true);
    const needing = tiles.find(t => t.hasAttribute("data-needs"));
    expect(needing?.className).toContain("!border-[var(--v2-warn)]");
    expect(needing?.textContent).toContain("needs you: approve edit a.ts");
  });
});

describe("sending", () => {
  it("the seat message line sends through the hub client to that seat", async () => {
    const calls: Calls = [];
    await mountScreen(fakeClient(calls));
    await typeInto(host.querySelector("input#v2-seatmsg"), "run the drill");
    await click(host.querySelector('button[aria-label="Send to codex-8"]'));
    const sent = calls.find(c => c.path === "/send");
    expect(JSON.parse(sent?.body ?? "{}")).toMatchObject({ to: "codex-8:trantor", text: "run the drill", project: "trantor", from: "sasha" });
  });

  it("an approval is answered in place via the hold decision", async () => {
    const calls: Calls = [];
    await mountScreen(fakeClient(calls, [HOLD]));
    expect(host.textContent).toContain("Allow codex-8 to edit");
    expect(tabText(chipFor("codex-8"))).toContain("needs you");
    await click([...host.querySelectorAll("button")].find(b => b.textContent === "Go") ?? null);
    const decided = calls.find(c => c.path === "/hold/decide");
    expect(JSON.parse(decided?.body ?? "{}")).toEqual({ id: 7, project: "trantor", status: "go" });
  });

  it("the 2.0 composer sends through the classic pane_send path", async () => {
    const onSent = vi.fn();
    const props: ComponentProps<typeof Composer> = {
      project: "trantor", target: "pane-1", live: true, liveWhy: "", model: "claude-opus-5-5", modelSource: "reported", working: false,
      userTexts: [], context: { tokens: 10, window: 100, frac: 0.1 }, fontStep: "m", onFontStep: () => {}, onSent,
      onLongRunChange: () => {}, onDispatch: () => {},
    };
    await act(async () => { root.render(<ComposerAdapter {...props} />); });
    await typeInto(host.querySelector("textarea"), "ship it");
    await click(host.querySelector('button[aria-label="Send"]'));
    expect(ipc.find(c => c.command === "pane_send")?.args).toEqual({ target: "pane-1", text: "ship it" });
    expect(onSent).toHaveBeenCalled();
    expect(host.querySelector("textarea")?.value).toBe("");
  });
});

const seat = (key: string): SeatView => {
  const target: PaneTarget = { key, label: key, agent: key, brand: key, session: `${key}:trantor`, online: true, isOrchestrator: false };
  return { key, label: key, agent: key, brand: key, session: target.session, presence: "ready", words: "ready", isOrchestrator: false, target };
};

describe("pure model", () => {
  it("judges herdr verdicts the way the classic composer does", () => {
    expect(judge({ outcome: "delivered", error: null }, null)).toEqual({ clear: true, note: null });
    expect(judge({ outcome: "sent", error: null }, null).clear).toBe(true);
    expect(judge({ outcome: "stalled", error: "no pane" }, null)).toEqual({ clear: false, note: "Not delivered: no pane" });
    expect(judge({ outcome: "blocked", error: null }, "Which file?").note).toContain("Which file?");
  });

  it("gives the message box to crew seats and not to the orchestrator (#14254)", () => {
    expect(takesSeatMessage(seat("codex-8"))).toBe(true);
    expect(takesSeatMessage({ ...seat("orchestrator"), isOrchestrator: true })).toBe(false);
  });

  it("tiles like the crew launcher and picks the seats each layout shows", () => {
    expect([1, 2, 3, 4, 5, 9].map(gridColumns)).toEqual([1, 2, 2, 2, 3, 3]);
    const live = [seat("a"), seat("b"), seat("c")];
    expect(visibleSeats("focus", live, live[1]).map(x => x.key)).toEqual(["b"]);
    expect(visibleSeats("split", live, live[1]).map(x => x.key)).toEqual(["b", "a"]);
    expect(visibleSeats("grid", live, live[1]).map(x => x.key)).toEqual(["a", "b", "c"]);
  });
});

it("shows a peer-list failure with its reason and recovers when reopened", async () => {
  let offline = true;
  const client = new HubClient("http://hub.test", async ({ path }) => {
    if (path.startsWith("/peers") && offline) throw new Error("hub unavailable for maintenance");
    const reply = path.startsWith("/peers") ? { peers: [] } : path.startsWith("/tasks") ? { tasks: [] } : { holds: [] };
    return { status: 200, body: JSON.stringify(reply) };
  });
  await mountScreen(client);
  expect(host.textContent).toContain("Can't reach the hub.");
  expect(host.textContent).toContain("hub unavailable for maintenance");
  expect(host.textContent).not.toContain("Reading seats");
  offline = false;
  await act(async () => { root.unmount(); });
  root = createRoot(host);
  await mountScreen(client);
  expect(host.textContent).not.toContain("Can't reach the hub.");
  expect(host.textContent).not.toContain("Reading seats");
});

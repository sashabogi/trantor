// @vitest-environment happy-dom
// #13987: the Workspace reads real peers, selection drives the inspector, and every send goes the classic way.
// Fakes sit at the boundaries only: the hub transport, the Tauri IPC, and the two heavy panes injected through panes.tsx.
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { HubClient, type FileHold, type Peer } from "../../../shared/api/client";
import type { Composer } from "../../../features/chat/Composer";
import type { PaneTarget } from "../../../features/workspace/paneTargets";
import { WorkspaceScreen } from "./index";
import { ComposerAdapter, judge } from "./ComposerAdapter";
import { DEFAULT_PANES, WorkspacePanesContext, type WorkspacePanes } from "./panes";
import { gridColumns, visibleSeats, type SeatView } from "./seatModel";

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
beforeEach(() => {
  ipc = [];
  mockIPC((command, args) => {
    ipc.push({ command, args });
    if (command === "herdr_seats") return "[]";
    if (command === "identity_name") return "sasha";
    if (command === "autonomy_get") return JSON.stringify({ resolved: { harness: "prompt", push: false, commit: true } });
    if (command === "git_panel") return JSON.stringify({ branch: "seat/codex-8", upstream: null, ahead: 1, behind: null, status: [], counts: [], log: [] });
    if (command === "seat_diff") return JSON.stringify({ branch: "seat/codex-8", base: "main", files: [{ path: "a.ts", plus: 3, minus: 1, untracked: false }], patch: "" });
    if (command === "pane_send") return { outcome: "delivered", error: null };
    if (command === "workspace_cli") {
      // SAFETY: workspace_cli is invoked with { project, args } by the crew control bridge.
      const argv = (args as { project: string; args: string[] }).args;
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
const chipFor = (name: string) => [...host.querySelectorAll("button[aria-pressed]")].find(b => b.textContent?.includes(name)) ?? null;
const terminalAgents = () => [...host.querySelectorAll("[data-testid=terminal]")].map(t => t.getAttribute("data-agent"));

describe("seat strip", () => {
  it("shows a chip per live seat of this project, the offline count and the add button", async () => {
    await mountScreen(fakeClient([]));
    expect(chipFor("codex-8")?.textContent).toContain("working");
    expect(chipFor("glm-5")?.textContent).toContain("ready");
    expect(chipFor("kimi-9")).toBeNull();
    expect(chipFor("MacBook")).toBeNull();
    expect(host.textContent).toContain("+1 offline");
    expect(host.querySelector('button[aria-label="Add a seat"]')).not.toBeNull();
    expect(host.querySelector('[role="group"][aria-label="Layout"]')).not.toBeNull();
  });
});

describe("selection and inspector", () => {
  it("selecting a seat swaps the inspector, the terminal and the card chip", async () => {
    await mountScreen(fakeClient([]));
    expect(terminalAgents()).toEqual(["codex-8"]);
    expect(host.querySelector('button[aria-label="Message codex-8"]')).not.toBeNull();
    expect(host.textContent).toContain("#13970");
    expect(host.textContent).toContain("seat/codex-8 ↑1");
    expect(host.textContent).toContain("New sessions: asks first");
    expect(host.querySelector('[title*="applies to new sessions and handoffs"]')).not.toBeNull();
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

  it("opens the worktree in Code through onNavigate", async () => {
    const go = vi.fn();
    await mountScreen(fakeClient([]), go);
    await click(host.querySelector('button[aria-label="Open codex-8\'s worktree in Code"]'));
    expect(go).toHaveBeenCalledWith("code");
  });

  it("Swap on a seat offers every agent but its own: no GLM row on glm-5, and the CLI swaps the seat (#14062)", async () => {
    await mountScreen(fakeClient([]));
    await click(chipFor("glm-5"));
    await click(host.querySelector('button[aria-label="Swap glm-5"]'));
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
    expect(chipFor("codex-8")?.textContent).toContain("needs you");
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

  it("tiles like the crew launcher and picks the seats each layout shows", () => {
    expect([1, 2, 3, 4, 5, 9].map(gridColumns)).toEqual([1, 2, 2, 2, 3, 3]);
    const live = [seat("a"), seat("b"), seat("c")];
    expect(visibleSeats("focus", live, live[1]).map(x => x.key)).toEqual(["b"]);
    expect(visibleSeats("split", live, live[1]).map(x => x.key)).toEqual(["b", "a"]);
    expect(visibleSeats("grid", live, live[1]).map(x => x.key)).toEqual(["a", "b", "c"]);
  });
});

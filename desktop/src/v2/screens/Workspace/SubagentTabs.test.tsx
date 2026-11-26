// @vitest-environment happy-dom
// #14265: Claude sub-agents are read-only live tabs after the crew seats and helpers, and a source control open
// from an agent worktree scope names that worktree. Fakes sit at the boundaries only: the hub transport and the Tauri IPC.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { HubClient, type Peer } from "../../../shared/api/client";
import { takeOpenIntent } from "../../shell/openIntent";
import { WorkspaceScreen } from "./index";
import { DEFAULT_PANES, WorkspacePanesContext, type WorkspacePanes } from "./panes";
import type { SubagentInfo } from "./seatModel";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PANES: WorkspacePanes = {
  TerminalPane: ({ agent }) => <div data-testid="terminal" data-agent={agent} />,
  RightPanel: () => <aside aria-label="Project panel" />,
};
const withPanes = (node: ReactNode) => <WorkspacePanesContext.Provider value={{ ...DEFAULT_PANES, ...PANES }}>{node}</WorkspacePanesContext.Provider>;

const PEERS: Peer[] = [{ session: "codex-8:trantor", project: "trantor", online: true, lastSeen: Date.now(), status: "idle", kind: "agent", llm: "codex" }];
const WORKTREE = "/repo/.claude/worktrees/agent-a3b04308faa";
const META = { model: "", version: "", branch: "", context: { tokens: null, window: 0, frac: null } };

const agent = (id: string, description: string, state: "running" | "done", ageMs = 1_000): SubagentInfo =>
  ({ id, description, subagentType: "general-purpose", startedMs: Date.now() - 60_000, lastActivityMs: Date.now() - ageMs, rows: 2, state });

type Say = { role: "user" | "assistant"; text: string };
let agents: SubagentInfo[];
let said: Record<string, Say[]>;
let tailCalls: { id: string; after: number }[];
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  agents = [];
  said = {};
  tailCalls = [];
  mockIPC((command, args) => {
    if (command === "subagents_list") return JSON.stringify(agents);
    if (command === "subagent_tail") {
      // SAFETY: the pane invokes subagent_tail with { project, id, after }.
      const { id, after } = args as { id: string; after: number };
      tailCalls.push({ id, after });
      const rows = said[id] ?? [];
      return JSON.stringify([rows.slice(after).map(r => ({ role: r.role, blocks: [{ kind: "text", text: r.text }] })), [], rows.length, META, []]);
    }
    if (command === "herdr_seats") return JSON.stringify([]);
    if (command === "identity_name") return "sasha";
    if (command === "autonomy_get") return JSON.stringify({ resolved: { harness: "prompt", push: false, commit: true } });
    if (command === "git_worktrees") return JSON.stringify([{ path: WORKTREE, branch: "worktree-agent-a3b04308faa", head: "aaa", locked: true, kind: "agent", last_activity: Math.floor(Date.now() / 1000), changed: 1, ahead: 1 }]);
    if (command === "git_panel") return JSON.stringify({ branch: "main", upstream: null, remote: null, ahead: 0, behind: null, status: [], counts: [], log: [{ sha: "abc1234def", author: "a", when: "now", subject: "agent commit" }] });
    if (command === "project_files" || command === "git_stash_list") return "[]";
    if (command === "plugin:event|listen") return 1;
    return null;
  });
  const mem = new Map<string, string>([["trantor.v2.workspace.filesOpen", "true"]]);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const client = () => new HubClient("http://hub.test", async ({ path }) => ({ status: 200, body: JSON.stringify(path.startsWith("/peers") ? { peers: PEERS } : path.startsWith("/tasks") ? { tasks: [] } : path.startsWith("/holds") ? { holds: [] } : { ok: true, id: 1 }) }));
const settle = (ms = 50) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const mount = async (onNavigate: (to: string) => void = () => {}) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  await act(async () => { root.render(withPanes(<WorkspaceScreen client={client()} project="trantor" onNavigate={onNavigate} />)); });
  await settle();
};
const click = (el: Element | null) => act(async () => { if (el instanceof HTMLElement) el.click(); });
const tabs = () => [...host.querySelectorAll<HTMLElement>('[role="tablist"][aria-label="Seats"] [role="tab"]')];
// #14365: crew tabs are icon-only, matched by aria-label; agent tabs by text.
const tabFor = (text: string) => tabs().find(t => `${t.getAttribute("aria-label") ?? ""}${t.textContent}`.includes(text)) ?? null;

describe("sub-agent tabs", () => {
  it("gives each running sub-agent a read-only tab after the crew seats, with an agent badge and a pulsing dot", async () => {
    agents = [agent("a1", "Review the diff", "running"), agent("a2", "Write the tests", "running")];
    await mount();
    // #14365: the crew seat tab is icon-only, so its name is the aria-label.
    expect(tabs().map(t => t.getAttribute("aria-label") ?? t.textContent)).toEqual([expect.stringContaining("codex-8"), expect.stringContaining("Review the diffrunningagent"), expect.stringContaining("Write the testsrunningagent")]);
    expect(tabFor("Review the diff")?.querySelector('[role="img"][aria-label="Running"].v2-agent-pulse')).not.toBeNull();
    await click(tabFor("Review the diff"));
    expect(host.querySelector('[data-testid="subagent-pane"]')?.getAttribute("data-agent-id")).toBe("a1");
    expect(host.querySelector('input#v2-seatmsg')).toBeNull();
    expect(host.querySelector('button[aria-label^="Send to"]')).toBeNull();
    expect(host.querySelector('[data-testid="terminal"]')).toBeNull();
    expect(host.querySelector('[role="tablist"][aria-label="Seat views"]')).toBeNull();
    await click(tabFor("codex-8"));
    expect(host.querySelector('input#v2-seatmsg')).not.toBeNull();
  });

  it("shows new rows as the tail grows, polling every 2 s while it runs", async () => {
    agents = [agent("a1", "Review the diff", "running")];
    said.a1 = [{ role: "user", text: "Review the diff please" }];
    await mount();
    await click(tabFor("Review the diff"));
    await settle();
    const log = () => host.querySelector('[role="log"]')?.textContent ?? "";
    expect(log()).toContain("Review the diff please");
    expect(log()).not.toContain("Found two issues");
    said.a1 = [...said.a1, { role: "assistant", text: "Found two issues" }];
    await settle(2_100);
    expect(log()).toContain("Found two issues");
    expect(log().match(/Review the diff please/g)).toHaveLength(1);
    expect(tailCalls[tailCalls.length - 1]).toEqual({ id: "a1", after: 1 });
    expect(host.querySelector('[data-testid="agent-summary"]')).toBeNull();
  });

  it("slows the poll to 15 s and puts the final message's first line on top once it is done", async () => {
    agents = [agent("a1", "Review the diff", "done", 30_000)];
    said.a1 = [{ role: "user", text: "Review the diff please" }, { role: "assistant", text: "All clear, no issues.\nSecond paragraph." }];
    await mount();
    await click(tabFor("Review the diff"));
    await settle();
    const summary = host.querySelector('[data-testid="agent-summary"]');
    expect(summary?.textContent).toBe("Finished: All clear, no issues.");
    const before = tailCalls.length;
    await settle(10_000);
    expect(tailCalls.length).toBe(before);
    await settle(5_500);
    expect(tailCalls.length).toBe(before + 1);
  });

  it("folds a finished agent into a +N finished menu after 10 minutes", async () => {
    agents = [agent("a1", "Review the diff", "done", 9 * 60_000), agent("a2", "Write the tests", "running")];
    await mount();
    expect(tabFor("Review the diff")).not.toBeNull();
    expect([...host.querySelectorAll("button")].some(b => b.textContent?.includes("+1 finished"))).toBe(false);
    await settle(2 * 60_000);
    expect(tabFor("Review the diff")).toBeNull();
    expect(tabFor("Write the tests")).not.toBeNull();
    const more = [...host.querySelectorAll("button")].find(b => b.textContent === "+1 finished");
    expect(more).toBeDefined();
    await click(more ?? null);
    await click(host.querySelector('[role="menu"][aria-label="Finished agents"] [role="menuitem"]'));
    expect(tabFor("Review the diff")?.getAttribute("aria-selected")).toBe("true");
  });

  it("tiles only running sub-agents in Grid, as conversations rather than terminals", async () => {
    agents = [agent("a1", "Review the diff", "running"), agent("a2", "Old job", "done", 60_000)];
    await mount();
    await click(host.querySelector('[role="group"][aria-label="Layout"] button[title="Grid: every seat"]'));
    await settle();
    expect(host.querySelectorAll('[data-testid="terminal"]')).toHaveLength(1);
    expect([...host.querySelectorAll('[data-testid="subagent-pane"]')].map(p => p.getAttribute("data-agent-id"))).toEqual(["a1"]);
  });
});

describe("an agent worktree scope in the sidebar", () => {
  it("opens a commit against that worktree, not the selected seat", async () => {
    const go = vi.fn();
    await mount(go);
    await settle(100);
    await click(host.querySelector(`button[data-agent-row="${WORKTREE}"]`));
    await settle(100);
    await click(host.querySelector('button[data-section-toggle="commits"]'));
    await click(host.querySelector('button[data-sha="abc1234def"]'));
    expect(go).toHaveBeenCalledWith("code");
    expect(takeOpenIntent("trantor")).toEqual({ kind: "commit", sha: "abc1234def", seat: `wt:${WORKTREE}` });
  });
});

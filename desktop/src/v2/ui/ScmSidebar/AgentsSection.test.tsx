// @vitest-environment happy-dom
// #14300: the Agents working section lists active agent and helper worktrees above Branches and seats, hides
// when there are none, a click scopes the sidebar to that worktree, and a commit that arrives on a later
// poll glows on its row. Fakes: the Tauri IPC and a per-test localStorage.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { ScmSidebar } from "./index";
import { takeOpenIntent } from "../../shell/openIntent";
import { CommitsSection } from "./CommitsSection";
import { useScopeGit } from "../../screens/Code/useScopeGit";
import type { ScopeSnapshot } from "../../screens/Code/useScopeGit";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nowSec = () => Math.floor(Date.now() / 1000);
const WORKTREES = [
  { path: "/repo/.claude/worktrees/agent-a3b04308faa", branch: "worktree-agent-a3b04308faa", head: "aaa", locked: true, kind: "agent", last_activity: nowSec() - 5, changed: 3, ahead: 1, files: ["desktop/src/App.tsx", "README.md", "src/a.ts"] },
  { path: "/tmp/scratchpad/wt-codex", branch: "work/codex", head: "bbb", locked: false, kind: "helper", last_activity: nowSec() - 30 * 60, changed: 1, ahead: 0, files: ["idle.txt"] },
  { path: "/home/.agent-bus/worktrees/trantor/glm", branch: "seat/glm", head: "ccc", locked: false, kind: "seat", last_activity: nowSec(), changed: 9, ahead: 9 },
];
const LOG = [{ sha: "abc1234def", author: "a", when: "2 hours ago", subject: "first commit" }];
const PANEL = (log = LOG) => ({ branch: "main", upstream: null, remote: null, ahead: 0, behind: null, status: [], counts: [], log });
const snap = (log = LOG): ScopeSnapshot => ({ scope: null, branch: "main", upstream: null, remote: null, ahead: 0, behind: null, status: [], counts: [], log, seatBacked: false, readAt: Date.now() });

type Call = { command: string; args: { agent?: string; scope?: string } };
let calls: Call[];
let worktreeReply: typeof WORKTREES | null;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  calls = [];
  worktreeReply = WORKTREES;
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
  mockIPC((command, payload) => {
    // SAFETY: mockIPC types payload as unknown; these commands are invoked with an object of named args.
    calls.push({ command, args: (payload ?? {}) as Call["args"] });
    if (command === "git_worktrees") return JSON.stringify(worktreeReply);
    if (command === "git_panel") return JSON.stringify(PANEL());
    if (command === "project_files" || command === "git_stash_list") return "[]";
    if (command === "plugin:event|listen") return 1;
    return null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove(); clearMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });
const renderSidebar = async (picked: (string | null)[] = [], log = LOG) => {
  await act(async () => {
    root.render(<ScmSidebar project="trantor" scope={null} scopeName="project checkout" state={{ kind: "ok", snap: snap(log) }} seats={[]}
      onPickScope={s => picked.push(s)} onMutated={() => undefined} onOpenFile={() => undefined} onOpenChange={() => undefined} onOpenCommit={() => undefined} />);
  });
  await flush(); await flush();
};
const click = (el: Element | null) => act(async () => { if (el instanceof HTMLElement) el.click(); });
const agentRows = () => [...host.querySelectorAll<HTMLButtonElement>("button[data-agent-row]")];

describe("Agents working", () => {
  it("lists active agent and helper worktrees above Branches and seats, never a seat", async () => {
    await renderSidebar();
    const sections = [...host.querySelectorAll("[data-section]")].map(s => s.getAttribute("data-section"));
    expect(sections.indexOf("agents")).toBeGreaterThan(-1);
    expect(sections.indexOf("agents")).toBeLessThan(sections.indexOf("branches"));
    const rows = agentRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("agent a3b0430");
    expect(rows[0].textContent).toContain("3 files changed · 1 commit");
    expect(rows[0].textContent).toContain("1m ago");
    expect(rows[1].textContent).toContain("helper codex");
    expect(rows[1].textContent).toContain("1 file changed · 0 commits");
    expect(rows[1].textContent).toContain("30m ago");
  });

  it("pulses the dot for a locked or just-changed worktree and not for an idle one", async () => {
    await renderSidebar();
    const dots = agentRows().map(r => r.querySelector("[data-live]") !== null);
    expect(dots).toEqual([true, false]);
  });

  it("is hidden when no worktree is active, or when the read fails", async () => {
    worktreeReply = [];
    await renderSidebar();
    expect(host.querySelector('[data-section="agents"]')).toBeNull();
    worktreeReply = null;
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await renderSidebar();
    expect(host.querySelector('[data-section="agents"]')).toBeNull();
  });

  it("a row click scopes the sidebar to that worktree and reads its git state", async () => {
    const picked: (string | null)[] = [];
    await renderSidebar(picked);
    await click(agentRows()[0]);
    await flush();
    expect(picked).toEqual(["wt:/repo/.claude/worktrees/agent-a3b04308faa"]);
    expect(calls.some(c => c.command === "git_panel" && c.args.agent === "wt:/repo/.claude/worktrees/agent-a3b04308faa")).toBe(true);
    expect(host.querySelector("[data-agent-row]")?.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector("header")?.textContent).toContain("agent a3b0430");
  });
});

describe("Agents working: changed files", () => {
  const fileRows = (row: Element) => [...row.parentElement!.querySelectorAll<HTMLButtonElement>("button[data-agent-file]")];

  it("a live row lists its changed files, base name then folder, and an idle row lists none", async () => {
    await renderSidebar();
    const [live, idle] = agentRows();
    const files = fileRows(live);
    expect(files.map(f => f.textContent)).toEqual(["App.tsxdesktop/src", "README.md", "a.tssrc"]);
    expect(files[0].querySelector("span")?.textContent).toBe("App.tsx");
    expect(fileRows(idle)).toHaveLength(0);
    expect(idle.parentElement?.textContent).not.toContain("idle.txt");
  });

  it("says how many more files changed than are listed, and shows nothing extra when all are listed", async () => {
    worktreeReply = [{ ...WORKTREES[0], changed: 9, files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"] }];
    await renderSidebar();
    const row = agentRows()[0];
    expect(fileRows(row)).toHaveLength(3);
    expect(row.parentElement?.textContent).toContain("+6 more");
    worktreeReply = [{ ...WORKTREES[0], changed: 3 }];
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await renderSidebar();
    expect(agentRows()[0].parentElement?.textContent).not.toContain("more");
  });

  it("a file click opens that worktree's file through the open intent, scoped to the worktree", async () => {
    await renderSidebar();
    await click(fileRows(agentRows()[0])[1]);
    expect(takeOpenIntent("trantor")).toEqual({ kind: "file", path: "README.md", seat: "wt:/repo/.claude/worktrees/agent-a3b04308faa" });
  });
});

describe("new commit highlight", () => {
  const html = (sha: string) => host.querySelector(`[data-sha="${sha}"]`);
  const NEW = { sha: "fff9999aaa", author: "o", when: "just now", subject: "landed" };

  it("marks only a commit that arrives after the first read", async () => {
    await act(async () => { root.render(<CommitsSection log={LOG} onOpen={() => undefined} />); });
    expect(html("abc1234def")?.hasAttribute("data-new")).toBe(false);
    await act(async () => { root.render(<CommitsSection log={[NEW, ...LOG]} onOpen={() => undefined} />); });
    expect(html("fff9999aaa")?.hasAttribute("data-new")).toBe(true);
    expect(html("fff9999aaa")?.className).toContain("v2-commit-new");
    expect(html("abc1234def")?.hasAttribute("data-new")).toBe(false);
  });

  it("the checkout's log reloads on the 6 s poll, so a landed commit shows without a remount", async () => {
    vi.useFakeTimers();
    let log = LOG;
    mockIPC(command => (command === "git_panel" ? JSON.stringify(PANEL(log)) : null));
    function Probe() {
      const { state } = useScopeGit("trantor", null);
      return state.kind === "ok" ? <CommitsSection log={state.snap.log} onOpen={() => undefined} /> : <div>loading</div>;
    }
    await act(async () => { root.render(<Probe />); await vi.advanceTimersByTimeAsync(10); });
    expect(host.querySelectorAll("[data-sha]")).toHaveLength(1);
    log = [NEW, ...LOG];
    await act(async () => { await vi.advanceTimersByTimeAsync(6_100); });
    expect(host.querySelectorAll("[data-sha]")).toHaveLength(2);
    expect(html("fff9999aaa")?.hasAttribute("data-new")).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(html("fff9999aaa")?.hasAttribute("data-new")).toBe(false);
  });
});

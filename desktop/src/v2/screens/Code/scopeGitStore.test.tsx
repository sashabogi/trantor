// @vitest-environment happy-dom
// #14344: every watcher of one scope shares ONE git_panel read per 6 s interval; a different scope is its own
// read; a refresh re-reads at once; the last unsubscribe stops the poll. Fake: the Tauri IPC, and timers.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { refreshScopeGit, subscribeScopeGit, SCOPE_POLL_MS } from "./scopeGitStore";
import { useScopeGit, type ScopeState } from "./useScopeGit";
import { useExplorerData } from "../../ui/useExplorerData";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Call = { command: string; agent?: string; scope?: string };
let calls: Call[];
let branch: string;
let host: HTMLDivElement;
let root: Root;

const lastOf = (list: ScopeState[]): ScopeState | undefined => list[list.length - 1];
const panels = () => calls.filter(c => c.command === "git_panel");
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  branch = "main";
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
  mockIPC((command, payload) => {
    // SAFETY: mockIPC types payload as unknown; these commands are invoked with an object of named args.
    const args = (payload ?? {}) as { agent?: string; scope?: string };
    calls.push({ command, agent: args.agent, scope: args.scope });
    if (command === "git_panel") return JSON.stringify({ branch, upstream: null, remote: null, ahead: 0, behind: null, status: [{ path: "a.ts", x: " ", y: "M" }], counts: [], log: [] });
    if (command === "project_files") return "[]";
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

describe("the shared scope read", () => {
  it("two subscribers of one scope cause one invoke at first and one per interval", async () => {
    const seen: ScopeState[][] = [[], []];
    const a = subscribeScopeGit("trantor", null, s => seen[0].push(s));
    const b = subscribeScopeGit("trantor", null, s => seen[1].push(s));
    await advance(10);
    expect(panels()).toHaveLength(1);
    await advance(SCOPE_POLL_MS);
    expect(panels()).toHaveLength(2);
    await advance(SCOPE_POLL_MS);
    expect(panels()).toHaveLength(3);
    expect(lastOf(seen[0])?.kind).toBe("ok");
    expect(lastOf(seen[1])).toBe(lastOf(seen[0]));
    a.unsubscribe(); b.unsubscribe();
  });

  it("a late subscriber gets the cached state at once without a new read", async () => {
    const first = subscribeScopeGit("trantor", null, () => undefined);
    await advance(10);
    const late: ScopeState[] = [];
    const second = subscribeScopeGit("trantor", null, s => late.push(s));
    expect(late[0]?.kind).toBe("ok");
    await advance(10);
    expect(panels()).toHaveLength(1);
    first.unsubscribe(); second.unsubscribe();
  });

  it("keeps scopes apart, and stops polling when the last subscriber leaves", async () => {
    const main = subscribeScopeGit("trantor", null, () => undefined);
    const seat = subscribeScopeGit("trantor", "glm-5", () => undefined);
    await advance(10);
    expect(panels().map(c => c.scope ?? c.agent)).toEqual(["project", "glm-5"]);
    main.unsubscribe();
    seat.unsubscribe();
    await advance(SCOPE_POLL_MS * 3);
    expect(panels()).toHaveLength(2);
  });

  it("refresh re-reads at once and a refresh by path re-reads a watched scope only", async () => {
    const seen: ScopeState[] = [];
    const sub = subscribeScopeGit("trantor", null, s => seen.push(s));
    await advance(10);
    branch = "feature";
    sub.refresh();
    await advance(10);
    expect(panels()).toHaveLength(2);
    const last = lastOf(seen);
    expect(last?.kind === "ok" ? last.snap.branch : null).toBe("feature");
    refreshScopeGit("trantor", null);
    refreshScopeGit("trantor", "nobody-watches-this");
    await advance(10);
    expect(panels()).toHaveLength(3);
    sub.unsubscribe();
  });

  it("an error reaches every subscriber and the next poll recovers", async () => {
    mockIPC(command => { if (command === "git_panel") throw new Error("git is gone"); return null; });
    const seen: ScopeState[] = [];
    const sub = subscribeScopeGit("trantor", null, s => seen.push(s));
    await advance(10);
    expect(lastOf(seen)).toEqual({ kind: "error", reason: "git is gone" });
    mockIPC(command => (command === "git_panel" ? JSON.stringify({ branch: "main", upstream: null, remote: null, ahead: 0, behind: null, status: [], counts: [], log: [] }) : null));
    await advance(SCOPE_POLL_MS + 10);
    expect(lastOf(seen)?.kind).toBe("ok");
    sub.unsubscribe();
  });
});

describe("the hooks that share it", () => {
  it("useScopeGit and the Explorer's status read cost one git_panel between them", async () => {
    function Both() {
      const git = useScopeGit("trantor", null);
      const tree = useExplorerData("trantor", null);
      return <div data-kind={git.state.kind} data-status={tree.gitStatus.size} />;
    }
    await act(async () => { root.render(<Both />); });
    await advance(50);
    expect(host.firstElementChild?.getAttribute("data-kind")).toBe("ok");
    expect(host.firstElementChild?.getAttribute("data-status")).toBe("1");
    expect(panels()).toHaveLength(1);
    await advance(SCOPE_POLL_MS + 50);
    expect(panels()).toHaveLength(2);
  });

  it("refresh from the hook after a mutation reads again", async () => {
    let refresh: () => void = () => undefined;
    function Probe() {
      refresh = useScopeGit("trantor", null).refresh;
      return null;
    }
    await act(async () => { root.render(<Probe />); });
    await advance(10);
    expect(panels()).toHaveLength(1);
    act(() => { refresh(); });
    await advance(10);
    expect(panels()).toHaveLength(2);
  });
});

// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { BranchPicker, type PickerActions } from "./BranchPicker";
import { MODE_KEY } from "../../shell/shellMode";
import { BRANCH_REFUSAL } from "./scopeGitApi";
import type { SeatInfo } from "./model";
import type { ScopeSnapshot } from "./useScopeGit";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Args = { project?: string; scope?: string; agent?: string; name?: string; sha?: string; dirty?: string; old?: string; new?: string; force?: boolean };
type Call = { command: string; args: Args };
let calls: Call[] = [];
let host: HTMLDivElement;
let root: Root;
let close: ReturnType<typeof vi.fn>;
let mutated: ReturnType<typeof vi.fn>;
let conflict: ReturnType<typeof vi.fn>;
let errors: ReturnType<typeof vi.fn>;
let worktreeRows: unknown[] = [];
let defaultBranch: string | null = "main";
let branchRows: typeof branches = [];

const branches = [
  { name: "main", sha: "a".repeat(40), committed_at: 100, ahead: 0, behind: 0, current: true, remote: false, worktree: null },
  { name: "topic", sha: "b".repeat(40), committed_at: 200, ahead: 2, behind: 1, current: false, remote: false, worktree: null },
  { name: "seat/dev", sha: "c".repeat(40), committed_at: 150, ahead: 1, behind: 0, current: false, remote: false, worktree: "/tmp/dev" },
  { name: "origin/topic", sha: "d".repeat(40), committed_at: 300, ahead: null, behind: null, current: false, remote: true, worktree: null },
];
const seats: SeatInfo[] = [{ seat: "dev", presence: "ready", branch: "seat/dev", ahead: 1, machine: null, hasWorktree: true }];
const acts: PickerActions = { onCheckout: vi.fn(), onSeat: vi.fn(), onCompare: vi.fn(), onMessage: vi.fn(), onCopy: vi.fn() };
const snapshot: ScopeSnapshot = { scope: null, branch: "main", upstream: "origin/main", remote: "origin", ahead: 0, behind: 0, status: [], counts: [], log: [], seatBacked: false, readAt: Date.now() };

beforeEach(() => {
  calls = [];
  defaultBranch = "main";
  branchRows = branches;
  vi.clearAllMocks();
  worktreeRows = [];
  close = vi.fn(); mutated = vi.fn(); conflict = vi.fn(); errors = vi.fn();
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => mem.get(key) ?? null, setItem: (key: string, value: string) => { mem.set(key, value); },
    removeItem: (key: string) => { mem.delete(key); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
  localStorage.setItem(MODE_KEY, "developer");
  mockIPC((command, raw) => {
    // SAFETY: every mocked invoke uses this command's named argument object.
    const args = (raw ?? {}) as Args;
    calls.push({ command, args });
    if (command === "git_branch_list") {
      const current = args.scope === "project" ? "main" : "seat/dev";
      return JSON.stringify({ current, default_branch: defaultBranch, branches: branchRows.map(branch => ({ ...branch, current: !branch.remote && branch.name === current })) });
    }
    if (command === "git_worktrees") return JSON.stringify(worktreeRows);
    if (command === "git_branch_switch" || command === "git_branch_merge" || command === "git_branch_rebase") return JSON.stringify({ status: "done", reason: "ok", conflicts: [] });
    if (command === "git_branch_delete") return JSON.stringify(args.force ? { status: "deleted", unique: 2 } : { status: "confirm", unique: 2 });
    return null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); vi.unstubAllGlobals(); });
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
const button = (text: string) => [...host.querySelectorAll("button")].find(item => item.textContent?.includes(text));
const click = async (target: HTMLElement | undefined) => { await act(async () => { target?.click(); }); await flush(); };
const mount = async (snap: ScopeSnapshot = snapshot, seatRows = seats, scope: string | null = null) => {
  await act(async () => {
    root.render(<BranchPicker project="trantor" seats={seatRows} snap={snap} scope={scope} acts={acts} onClose={close} onMutated={mutated} onError={errors} onOpenConflict={conflict} />);
  });
  await flush();
};
const input = async (value: string) => {
  const field = host.querySelector<HTMLInputElement>('input[aria-label="New branch name"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field?.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("BranchPicker", () => {
  it("refuses branch changes on the main checkout in Orchestrator mode, with the reason on the button", async () => {
    localStorage.setItem(MODE_KEY, "orchestrator");
    await mount();
    const create = button("Create branch…");
    expect(create?.disabled).toBe(true);
    expect(create?.title).toBe(BRANCH_REFUSAL);
    expect(host.querySelector<HTMLButtonElement>('button[title="Switch to topic"]')).toBeNull();
    expect(calls.some(call => call.command.startsWith("git_branch_") && call.command !== "git_branch_list")).toBe(false);
  });

  it("lists real local and remote metadata and creates a branch from HEAD", async () => {
    await mount();
    expect(host.textContent).toContain("origin/topic");
    expect(host.textContent).toContain("↑2");
    expect(host.textContent).toContain("↓1");
    expect(host.querySelector('[role="img"]')).not.toBeNull();
    await click(button("Create branch…"));
    await input("feature/new");
    await click([...host.querySelectorAll("button")].find(item => item.textContent === "Create branch"));
    expect(calls.find(call => call.command === "git_branch_create")?.args).toEqual({ project: "trantor", scope: "project", name: "feature/new", sha: null });
    expect(mutated).toHaveBeenCalled();
  });

  it("offers bring or stash for a dirty switch and names the target in the request", async () => {
    await mount({ ...snapshot, status: [{ path: "a.ts", x: " ", y: "M" }] });
    await click(host.querySelector<HTMLButtonElement>('button[title="Switch to topic"]') ?? undefined);
    expect(host.textContent).toContain("Bring 1 changed path(s) to topic");
    expect(calls.some(call => call.command === "git_branch_switch")).toBe(false);
    await click(button("Stash and switch"));
    expect(calls.find(call => call.command === "git_branch_switch")?.args).toEqual({ project: "trantor", scope: "project", name: "topic", dirty: "stash" });
  });

  it("renames and confirms an unmerged delete with its unique commit count", async () => {
    await mount();
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="More actions for topic"]') ?? undefined);
    await click(button("Rename branch…"));
    await input("renamed");
    await click(button("Rename branch"));
    expect(calls.find(call => call.command === "git_branch_rename")?.args).toMatchObject({ old: "topic", new: "renamed" });
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="More actions for topic"]') ?? undefined);
    await click(button("Delete branch…"));
    expect(host.textContent).toContain("has 2 commits that the current branch does not have");
    expect(calls.find(call => call.command === "git_branch_delete")?.args.force).toBe(false);
    await click(button("Delete topic"));
    const deletes = calls.filter(call => call.command === "git_branch_delete");
    expect(deletes[deletes.length - 1]?.args.force).toBe(true);
  });

  it("shows main and checked-out branch refusal reasons before delete", async () => {
    await mount();
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="More actions for main"]') ?? undefined);
    const remove = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent?.includes("Delete branch"));
    expect(remove?.disabled).toBe(true);
    expect(remove?.title).toBe("main is protected and cannot be deleted");
    expect(calls.some(call => call.command === "git_branch_delete")).toBe(false);
  });

  it("opens the existing conflict view when merge stops on conflicts", async () => {
    await mount();
    mockIPC((command, raw) => {
      // SAFETY: every mocked invoke uses this command's named argument object.
      const args = (raw ?? {}) as Args;
      calls.push({ command, args });
      if (command === "git_branch_list") {
        const current = args.scope === "project" ? "main" : "seat/dev";
        return JSON.stringify({ current, default_branch: defaultBranch, branches: branchRows.map(branch => ({ ...branch, current: !branch.remote && branch.name === current })) });
      }
      if (command === "git_branch_merge") return JSON.stringify({ status: "conflict", reason: "paused", conflicts: ["a.ts"] });
      return null;
    });
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="More actions for topic"]') ?? undefined);
    await click(button("Merge into the current branch"));
    expect(conflict).toHaveBeenCalledWith("a.ts");
    expect(mutated).toHaveBeenCalled();
  });

  it("rebases the current branch onto a selected branch", async () => {
    await mount();
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="More actions for topic"]') ?? undefined);
    await click(button("Rebase current onto this branch"));
    expect(calls.find(call => call.command === "git_branch_rebase")?.args).toEqual({ project: "trantor", scope: "project", name: "topic" });
  });

  it("refuses a working seat's mutations before the click", async () => {
    const current = { ...snapshot, scope: "dev", branch: "seat/dev", seatBacked: true };
    const working = [{ ...seats[0], presence: "working" as const }];
    await mount(current, working, "dev");
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="More actions for seat/dev"]') ?? undefined);
    const rebase = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent?.includes("Rebase this seat branch"));
    expect(rebase?.disabled).toBe(true);
    expect(rebase?.title).toContain("dev is working");
    expect(calls.some(call => call.command === "git_branch_rebase")).toBe(false);
  });

  it.each(["master", "release/stable"])("uses %s for seat labels, compare and rebase", async name => {
    defaultBranch = name;
    branchRows = [...branches, { ...branches[0], name, current: false }];
    await mount({ ...snapshot, scope: "dev", branch: "seat/dev", seatBacked: true }, seats, "dev");
    expect(host.querySelector(`[title="1 commits ahead of ${name}"]`)).not.toBeNull();
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="More actions for seat/dev"]') ?? undefined);
    expect(host.textContent).toContain(`1 ahead of ${name}`);
    await click(button(`Compare with ${name}`));
    expect(acts.onCompare).toHaveBeenCalledWith("dev");
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="More actions for seat/dev"]') ?? undefined);
    await click(button(`Rebase this seat branch onto ${name}`));
    expect(calls.find(call => call.command === "git_branch_rebase")?.args).toEqual({ project: "trantor", agent: "dev", name });
  });

  it.each(["master", "release/stable"])("protects %s and allows deleting a non-default main", async name => {
    defaultBranch = name;
    branchRows = [...branches, { ...branches[0], name, current: false }];
    await mount({ ...snapshot, scope: "dev", branch: "seat/dev", seatBacked: true }, seats, "dev");
    await click(host.querySelector<HTMLButtonElement>(`button[aria-label="More actions for ${name}"]`) ?? undefined);
    const remove = button("Delete branch…");
    expect(remove?.disabled).toBe(true);
    expect(remove?.title).toBe(`${name} is protected and cannot be deleted`);
    await click(remove);
    expect(calls.some(call => call.command === "git_branch_delete")).toBe(false);
    await click(host.querySelector<HTMLButtonElement>(`button[aria-label="More actions for ${name}"]`) ?? undefined);
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="More actions for main"]') ?? undefined);
    expect(button("Delete branch…")?.disabled).toBe(false);
  });

  it("rebases onto the remote default when no local copy exists", async () => {
    defaultBranch = "release/stable";
    branchRows = [...branches, { ...branches[3], name: "origin/release/stable" }];
    await mount({ ...snapshot, scope: "dev", branch: "seat/dev", seatBacked: true }, seats, "dev");
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="More actions for seat/dev"]') ?? undefined);
    await click(button("Rebase this seat branch onto release/stable"));
    expect(calls.find(call => call.command === "git_branch_rebase")?.args.name).toBe("origin/release/stable");
  });

  it("disables default-branch actions when no default is available", async () => {
    defaultBranch = null;
    await mount({ ...snapshot, scope: "dev", branch: "seat/dev", seatBacked: true }, seats, "dev");
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="More actions for seat/dev"]') ?? undefined);
    expect(button("Compare with default branch")?.disabled).toBe(true);
    expect(button("Rebase this seat branch onto default branch")?.disabled).toBe(true);
    expect(host.textContent).not.toContain("ahead of main");
  });

  // #14300: active agent worktrees are scopes too, listed under their own heading and hidden when there are none.
  it("lists active agent worktrees under Agent worktrees and picks one as the scope", async () => {
    await mount();
    expect(host.textContent).not.toContain("Agent worktrees");
    worktreeRows = [{ path: "/r/.claude/worktrees/agent-abcdef123", branch: "worktree-agent-abcdef123", head: "a", locked: true, kind: "agent", last_activity: Math.floor(Date.now() / 1000), changed: 2, ahead: 0 }];
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await mount();
    expect(host.textContent).toContain("Agent worktrees");
    const row = host.querySelector<HTMLButtonElement>("button[data-agent-worktree]");
    expect(row?.textContent).toContain("agent abcdef1");
    expect(row?.textContent).toContain("2 files changed · 0 commits");
    await click(row ?? undefined);
    expect(acts.onSeat).toHaveBeenCalledWith("wt:/r/.claude/worktrees/agent-abcdef123");
    expect(close).toHaveBeenCalled();
  });
});

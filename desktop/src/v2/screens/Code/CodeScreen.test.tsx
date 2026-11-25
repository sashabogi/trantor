// @vitest-environment happy-dom
// #13988: the screen folds its sidebar while Source control is open, groups seats in the branch
// picker, and reads history and changes from the classic git commands.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { HubClient } from "../../../shared/api/client";
import { CodeScreen } from "./index";
import { MODE_KEY } from "../../shell/shellMode";
// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PEERS = { peers: [{ session: "codex-8:trantor", project: "trantor", lastSeen: Date.now(), machine: "netcup" }] };
const PANEL = {
  branch: "seat/codex-8", upstream: null, ahead: 3, behind: null, status: [], counts: [],
  log: [{ sha: "abc1234", author: "sashabogi", when: "2 hours ago", subject: "#13970 Restore opted-in projects" }],
};

// #13988 drill: the main checkout answers git_panel by scope "project", with real staging.
const CHECKOUT = {
  branch: "main", upstream: "origin/main", ahead: 2, behind: 1,
  status: [{ path: "bin/a.mjs", x: " ", y: "M" }, { path: "src/staged.ts", x: "M", y: " " }],
  counts: [{ path: "bin/a.mjs", plus: 4, minus: 1 }],
  log: [{ sha: "fedcba9", author: "orchestrator", when: "5 minutes ago", subject: "#13988 Land the checkout panel" }],
};
const SHOW = {
  sha: "fedcba9000000000000000000000000000000000", truncated: false,
  files: [{ path: "src/landed.ts", status: "M", plus: 1, minus: 1 }],
  patch: "diff --git a/src/landed.ts b/src/landed.ts\n--- a/src/landed.ts\n+++ b/src/landed.ts\n@@ -1,1 +1,1 @@\n-before\n+after landing\n",
};
type IpcArgs = { project?: string; agent?: string; scope?: string; sha?: string; name?: string; paths?: string[]; unstage?: boolean; message?: string; strategy?: string; reference?: string; action?: string };
type Call = { command: string; args: IpcArgs };
let calls: Call[] = [];

const client = new HubClient("http://hub.test", async ({ path }) => {
  if (path.startsWith("/peers")) return { status: 200, body: JSON.stringify(PEERS) };
  return { status: 200, body: JSON.stringify({ tasks: [], entries: [], messages: [] }) };
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  calls = [];
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
  mockIPC((command, args) => {
    // SAFETY: mockIPC types args as unknown; the git commands are invoked with an object of named args.
    const named = (args ?? {}) as IpcArgs;
    calls.push({ command, args: named });
    const agent = named.agent;
    if (command === "git_panel") return JSON.stringify(agent === "codex-8" ? PANEL : named.scope === "project" ? CHECKOUT : null);
    if (command === "git_show") return JSON.stringify(SHOW);
    if (command === "git_stage" || command === "git_commit") return named.scope === "project" ? "1234abc" : null;
    if (command === "git_push") return "main";
    if (command === "git_discard") return "/Trash/Trantor discard test";
    if (command === "git_pull") return JSON.stringify(named.strategy === "ff" ? { status: "diverged", reason: "Branches diverged. Choose Merge or Rebase." } : { status: "pulled", reason: "Integrated" });
    if (command === "git_stash_list") return "[]";
    if (command === "git_branch_list") return JSON.stringify({ current: named.scope === "project" ? "main" : "seat/codex-8", branches: [] });
    if (command === "file_diff") return "diff --git a/bin/a.mjs b/bin/a.mjs\n--- a/bin/a.mjs\n+++ b/bin/a.mjs\n@@ -1,1 +1,1 @@\n-old\n+new\n";
    if (command === "seat_diff") return JSON.stringify({ branch: "seat/codex-8", base: "deadbee", files: [], patch: "", truncated: false });
    if (command === "plugin:event|listen") return 1;
    return null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); vi.unstubAllGlobals(); });

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });
const mount = async () => { await act(async () => { root.render(<CodeScreen client={client} project="trantor" onNavigate={() => undefined} />); }); await flush(); await flush(); };
const click = async (sel: string) => { await act(async () => { host.querySelector<HTMLElement>(sel)?.click(); }); await flush(); };

describe("CodeScreen", () => {
  // #14071 drill on rock-os: under a short tab body the panel floated mid-column with empty space below it.
  it("lets the tab body fill the column so the bottom panel sits under it at the bottom", async () => {
    await mount();
    const body = host.querySelector('[data-testid="code-main"]');
    expect(body?.className).toContain("flex-1");
    const panel = body?.nextElementSibling;
    expect(panel?.matches('section[aria-label="Bottom panel"]') || panel?.querySelector('button[aria-label="Open bottom panel"]') != null).toBe(true);
  });

  it("folds the source control sidebar into the icon bar while the Source control tab is open", async () => {
    await mount();
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Source control");
    expect(host.querySelector('aside[aria-label="Source control"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Show the source control sidebar"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Source control, 2 changes"]')).not.toBeNull();
    await click('button[aria-label="Explorer"]');
    expect(host.querySelector('aside[aria-label="Explorer"]')).not.toBeNull();
  });

  it("lists the changed file as a chip above the diff and never wraps code", async () => {
    await mount();
    const chip = host.querySelector('[aria-label="Changed files"] button');
    expect(chip?.textContent).toContain("bin/a.mjs");
    expect(host.querySelector("[data-diff-scroll]")?.textContent).toContain("new");
    expect(host.querySelector('[data-kind="add"]')?.className).toContain("whitespace-pre");
  });

  it("groups seats in the branch picker and reads history from the seat's panel", async () => {
    await mount();
    await click('button[title="Switch branch"]');
    const picker = host.querySelector('[role="dialog"][aria-label="Switch branch"]');
    expect(picker?.textContent).toContain("This checkout");
    expect(picker?.textContent).toContain("Seats · each in its own worktree");
    expect(picker?.textContent).toContain("seat/codex-8");
    const row = [...(picker?.querySelectorAll("button") ?? [])].find(b => b.textContent?.includes("seat/codex-8"));
    await act(async () => { row?.click(); });
    await flush();
    await flush();
    const commit = host.querySelector('[data-sha="abc1234"]');
    expect(commit?.textContent).toContain("Restore opted-in projects");
    expect(commit?.textContent).toContain("#13970");
    expect(commit?.textContent).toContain("codex-8");
    expect(host.querySelector('[data-sha="unlanded"]')?.textContent).toContain("3 commits not on main yet");
    await click('[data-sha="abc1234"]');
    expect(calls.find(c => c.command === "git_show")?.args).toMatchObject({ project: "trantor", agent: "codex-8", sha: "abc1234" });
    expect(host.querySelector("[data-diff-scroll]")?.textContent).toContain("after landing");
  });
});

const button = (text: string) => [...host.querySelectorAll("button")].find(b => b.textContent?.includes(text));

describe("CodeScreen on the project's main checkout (#13988 drill)", () => {
  it("shows the real branch, ahead and behind, the main checkout mark, and refuses push with the reason", async () => {
    await mount();
    expect(host.querySelector('button[title="Switch branch"]')?.textContent).toContain("main");
    expect(host.querySelector('[data-testid="checkout-ahead"]')?.textContent).toContain("↑2 ↓1");
    expect(host.querySelector('[data-testid="checkout-ahead"] [data-main-checkout]')).not.toBeNull();
    await click('button[title="Fetch, pull or push this checkout"]');
    const push = button("Push ↑2");
    expect(push?.disabled).toBe(true);
    expect(push?.title).toBe("On the main checkout, pushing and discarding go through the orchestrator");
    const discard = host.querySelector<HTMLButtonElement>('button[aria-label="Discard bin/a.mjs"]');
    expect(discard?.disabled).toBe(true);
    expect(discard?.title).toBe("On the main checkout, pushing and discarding go through the orchestrator");
    expect(calls.find(c => c.command === "git_panel")?.args).toEqual({ project: "trantor", scope: "project" });
    expect(calls.some(c => c.command === "git_push")).toBe(false);
  });

  it("allows clicked push and confirmed Trash-backed discard in Developer mode", async () => {
    localStorage.setItem(MODE_KEY, "developer");
    await mount();
    await click('button[title="Fetch, pull or push this checkout"]');
    await act(async () => { button("Push ↑2")?.click(); });
    await flush();
    expect(calls.find(c => c.command === "git_push")?.args).toEqual({ project: "trantor", scope: "project" });
    await click('button[aria-label="Discard bin/a.mjs"]');
    expect(host.querySelector('[data-discard-confirm="bin/a.mjs"]')?.textContent).toContain("untracked files are removed");
    expect(calls.some(c => c.command === "git_discard")).toBe(false);
    await click('[data-discard-confirm="bin/a.mjs"] button[data-variant="danger"]');
    expect(calls.find(c => c.command === "git_discard")?.args).toEqual({ project: "trantor", scope: "project", paths: ["bin/a.mjs"] });
  });

  it("offers Merge and Rebase only after a fast-forward pull reports divergence", async () => {
    await mount();
    await click('button[title="Fetch, pull or push this checkout"]');
    await act(async () => { button("Pull")?.click(); });
    await flush();
    expect(host.querySelector('[role="menu"]')?.textContent).toContain("Branches diverged");
    await act(async () => { button("Rebase")?.click(); });
    await flush();
    expect(calls.filter(c => c.command === "git_pull").map(c => c.args.strategy)).toEqual(["ff", "rebase"]);
  });

  it("stages, unstages and commits on the checkout by scope, never by an agent", async () => {
    await mount();
    const commit = button("Commit 1 file to main");
    expect(commit?.querySelector("[data-main-checkout]")).not.toBeNull();
    await click('button[aria-label="Unstage src/staged.ts"]');
    expect(calls.find(c => c.command === "git_stage")?.args).toEqual({ project: "trantor", scope: "project", paths: ["src/staged.ts"], unstage: true });
    await click('button[aria-label="Stage bin/a.mjs"]');
    expect(calls.filter(c => c.command === "git_stage")[1]?.args).toEqual({ project: "trantor", scope: "project", paths: ["bin/a.mjs"], unstage: false });
    const input = host.querySelector<HTMLInputElement>("#v2-commit-msg");
    await act(async () => {
      if (!input) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "#13988 land it");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { button("Commit 1 file to main")?.click(); });
    await flush();
    expect(calls.find(c => c.command === "git_commit")?.args).toEqual({ project: "trantor", scope: "project", message: "#13988 land it" });
  });

  it("lists the checkout's history and shows the selected commit's own files and diff", async () => {
    await mount();
    await click('[role="group"][aria-label="View"] button:last-child');
    const row = host.querySelector('[data-sha="fedcba9"]');
    expect(row?.textContent).toContain("Land the checkout panel");
    expect(row?.textContent).toContain("#13988");
    expect(host.querySelector('[data-sha="unlanded"]')).toBeNull();
    expect(host.querySelector("[data-not-wired]")).toBeNull();
    await flush();
    expect(calls.find(c => c.command === "git_show")?.args).toEqual({ project: "trantor", scope: "project", sha: "fedcba9" });
    expect(host.querySelector('[aria-label="Changed files"]')?.textContent).toContain("src/landed.ts");
    expect(host.querySelector("[data-diff-scroll]")?.textContent).toContain("after landing");
  });

  it("creates a branch from the selected commit", async () => {
    localStorage.setItem(MODE_KEY, "developer");
    await mount();
    await click('[role="group"][aria-label="View"] button:last-child');
    await click('[data-sha="fedcba9"]');
    await click('button[aria-label="Create a branch here"]');
    const input = host.querySelector<HTMLInputElement>('input[aria-label="New branch name"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "from-commit");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { button("Create branch")?.click(); });
    await flush();
    expect(calls.find(c => c.command === "git_branch_create")?.args).toEqual({ project: "trantor", scope: "project", name: "from-commit", sha: "fedcba9" });
  });
});

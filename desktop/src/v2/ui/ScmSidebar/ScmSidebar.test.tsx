// @vitest-environment happy-dom
// #14044 drill: the source control sidebar's header, flat Changes list, Files, Recent commits,
// remembered sections and clicks; #14047 ahead/behind + seats rows; #14058 every header stays on
// screen, each open body scrolls in itself. Fakes: the Tauri IPC and a per-test localStorage.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { ScmSidebar } from "./index";
import { flatChanges } from "./ChangesSection";
import { readScmSectionOpen, writeScmSectionOpen, SCM_KEY_PREFIX } from "./sectionState";
import type { SeatInfo } from "../../screens/Code/model";
import type { ScopeSnapshot, ScopeState } from "../../screens/Code/useScopeGit";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STATUS = [
  { path: "bin/a.mjs", x: " ", y: "M" },
  { path: "src/staged.ts", x: "M", y: " " },
  { path: "fresh.ts", x: "?", y: "?" },
  { path: "src/c.ts", x: "U", y: "U" },
];
const LOG = [
  { sha: "abc1234def", author: "glm-5", when: "2 hours ago", subject: "#14044 Flat changes list" },
  { sha: "fedcba9876", author: "orchestrator", when: "5 hours ago", subject: "Land the sidebar" },
];
const PANEL = { branch: "seat/glm-5", upstream: null, ahead: 2, behind: null, status: STATUS, counts: [{ path: "bin/a.mjs", plus: 4, minus: 1 }], log: LOG };
const SEAT_SNAP: ScopeSnapshot = { scope: "glm-5", branch: "seat/glm-5", upstream: null, ahead: 2, behind: null, status: STATUS, counts: [{ path: "bin/a.mjs", plus: 4, minus: 1 }], log: LOG, seatBacked: true, readAt: Date.now() };
const CHECKOUT_SNAP: ScopeSnapshot = { scope: null, branch: "main", upstream: "origin/main", ahead: 0, behind: 0, status: STATUS, counts: [], log: LOG, seatBacked: false, readAt: Date.now() };
const ROOTS = JSON.stringify([{ name: "README.md", path: "README.md", dir: false, status: "M" }]);
const SEATS: SeatInfo[] = [
  { seat: "glm-5", presence: "working", branch: "seat/glm-5", ahead: 2, machine: null, hasWorktree: true },
  { seat: "kimi-9", presence: "offline", branch: null, ahead: null, machine: "netcup", hasWorktree: false },
];

type IpcArgs = { project?: string; agent?: string; scope?: string; paths?: string[]; unstage?: boolean; message?: string };
type Call = { command: string; args: IpcArgs };
let calls: Call[];
type Opened = { file: string[]; change: string[]; commit: string[] };
const opened: Opened = { file: [], change: [], commit: [] };
let picked: (string | null)[];
let fetchReply: (() => void | Promise<void>) | null;
let mutations: number;

let host: HTMLDivElement;
let root: Root;
let state: ScopeState = { kind: "ok", snap: SEAT_SNAP };
beforeEach(() => {
  calls = [];
  opened.file = []; opened.change = []; opened.commit = [];
  picked = [];
  fetchReply = null;
  mutations = 0;
  state = { kind: "ok", snap: SEAT_SNAP };
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
  mockIPC((command, payload) => {
    // SAFETY: mockIPC types payload as unknown; these commands are invoked with an object of named args.
    const args = (payload ?? {}) as IpcArgs;
    calls.push({ command, args });
    if (command === "project_files") return ROOTS;
    if (command === "git_panel") return JSON.stringify(PANEL);
    if (command === "git_stage") return null;
    if (command === "git_commit") return "newsha";
    if (command === "git_fetch") return fetchReply?.();
    if (command === "plugin:event|listen") return 1;
    return null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove(); clearMocks(); vi.unstubAllGlobals();
});

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });
const render = async (project = "trantor") => {
  await act(async () => {
    root.render(<ScmSidebar project={project} scope="glm-5" scopeName="glm-5" state={state} seats={SEATS}
      onPickScope={s => picked.push(s)} onMutated={() => { mutations += 1; }}
      onOpenFile={p => opened.file.push(p)} onOpenChange={p => opened.change.push(p)} onOpenCommit={s => opened.commit.push(s)} />);
  });
  await flush(); await flush();
};
const click = (el: Element | null) => act(async () => { if (el instanceof HTMLElement) el.click(); });
const byLabel = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const sectionBody = (s: string) => host.querySelector(`[data-section-body="${s}"]`);
const typeMessage = async (text: string) => {
  const input = host.querySelector<HTMLInputElement>("#v2-commit-msg");
  await act(async () => {
    if (!input) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("flatChanges", () => {
  it("gives every changed path one row with the chip letter and the stage direction", () => {
    const rows = flatChanges(STATUS);
    expect(rows.map(r => [r.path, r.letter])).toEqual([
      ["bin/a.mjs", "M"], ["src/staged.ts", "M"], ["fresh.ts", "U"], ["src/c.ts", "M"],
    ]);
    expect(rows.find(r => r.path === "src/staged.ts")).toMatchObject({ staged: true, unstaged: false, conflict: false });
    expect(rows.find(r => r.path === "bin/a.mjs")).toMatchObject({ staged: false, unstaged: true });
    expect(rows.find(r => r.path === "fresh.ts")).toMatchObject({ staged: false, unstaged: true });
    expect(rows.find(r => r.path === "src/c.ts")).toMatchObject({ conflict: true, staged: false });
  });
});

describe("section persistence", () => {
  it("defaults open and stores the choice under trantor.v2.scm.<section>", () => {
    expect(readScmSectionOpen("changes")).toBe(true);
    writeScmSectionOpen("changes", false);
    expect(readScmSectionOpen("changes")).toBe(false);
    expect(readScmSectionOpen("files")).toBe(true);
  });
});

describe("the sidebar", () => {
  it("reads Source control with the branch and scope name, and lists all three sections", async () => {
    await render();
    expect(host.textContent).toContain("Source control");
    expect(host.textContent).toContain("seat/glm-5");
    expect(host.textContent).toContain("glm-5");
    expect(sectionBody("changes")).not.toBeNull();
    expect(sectionBody("files")).not.toBeNull();
    expect(sectionBody("commits")).not.toBeNull();
  });

  it("shows every changed file in one flat list, staged and unstaged together", async () => {
    await render();
    const list = sectionBody("changes");
    for (const path of ["bin/a.mjs", "src/staged.ts", "fresh.ts", "src/c.ts"]) {
      expect(list?.querySelector(`[data-change="${path}"]`)).not.toBeNull();
    }
    expect(host.querySelector('[data-change="bin/a.mjs"]')?.textContent).toContain("+4");
    expect(byLabel("Stage bin/a.mjs")).not.toBeNull();
    expect(byLabel("Unstage src/staged.ts")).not.toBeNull();
    expect(host.querySelector("[data-count]")?.textContent).toBe("4");
  });

  it("keeps the conflict row protected and discard refused everywhere", async () => {
    await render();
    expect(byLabel("Stage src/c.ts")?.disabled).toBe(true);
    expect(byLabel("Stage src/c.ts")?.title).toContain("conflict record");
    expect(host.querySelector('[data-change="src/c.ts"] button[title="Resolve this conflict"]')).not.toBeNull();
    expect(byLabel("Discard bin/a.mjs")?.disabled).toBe(true);
    expect(byLabel("Discard bin/a.mjs")?.title).toContain("git restore");
  });

  it("stages and unstages per row through the scope git bridge", async () => {
    await render();
    await click(byLabel("Stage bin/a.mjs"));
    expect(calls.find(c => c.command === "git_stage")?.args).toEqual({ project: "trantor", agent: "glm-5", paths: ["bin/a.mjs"], unstage: false });
    await click(byLabel("Unstage src/staged.ts"));
    expect(calls.filter(c => c.command === "git_stage")[1]?.args).toEqual({ project: "trantor", agent: "glm-5", paths: ["src/staged.ts"], unstage: true });
  });

  it("Stage all batches every non-conflicted change in one call", async () => {
    await render();
    const button = [...host.querySelectorAll("button")].find(b => b.textContent === "Stage all");
    await click(button ?? null);
    expect(calls.find(c => c.command === "git_stage")?.args).toEqual({ project: "trantor", agent: "glm-5", paths: ["bin/a.mjs", "fresh.ts"], unstage: false });
  });

  it("commits through the bridge with the staged count", async () => {
    await render();
    await typeMessage("#14044 land it");
    await click([...host.querySelectorAll("button")].find(b => b.textContent?.includes("Commit 1 file to seat/glm-5")) ?? null);
    await flush();
    expect(calls.find(c => c.command === "git_commit")?.args).toEqual({ project: "trantor", agent: "glm-5", message: "#14044 land it" });
  });

  it("on the main checkout the refusal travels with the commit box and discard", async () => {
    state = { kind: "ok", snap: CHECKOUT_SNAP };
    await render();
    const commit = [...host.querySelectorAll("button")].find(b => b.textContent?.includes("Commit 1 file to main"));
    expect(commit?.querySelector("[data-main-checkout]")).not.toBeNull();
    expect(byLabel("Discard bin/a.mjs")?.title).toContain("orchestrator");
  });

  it("collapses one section, remembers it across a remount, and reopens", async () => {
    await render();
    await click(host.querySelector('button[data-section-toggle="changes"]'));
    expect(sectionBody("changes")).toBeNull();
    expect(sectionBody("files")).not.toBeNull();
    expect(localStorage.getItem(`${SCM_KEY_PREFIX}.changes`)).toBe("false");
    await render();
    expect(sectionBody("changes")).toBeNull();
    await click(host.querySelector('button[data-section-toggle="changes"]'));
    expect(sectionBody("changes")).not.toBeNull();
    expect(localStorage.getItem(`${SCM_KEY_PREFIX}.changes`)).toBe("true");
  });

  it("a changed file, a commit and a file each reach the host", async () => {
    await render();
    await click(host.querySelector('button[title="Show the diff for bin/a.mjs"]'));
    expect(opened.change).toEqual(["bin/a.mjs"]);
    await click(host.querySelector('[data-sha="abc1234def"]'));
    expect(opened.commit).toEqual(["abc1234def"]);
    await click(host.querySelector('[role="treeitem"][data-path="README.md"]'));
    expect(opened.file).toEqual(["README.md"]);
  });

  it("empty git data says so instead of stub sections", async () => {
    state = { kind: "ok", snap: { ...SEAT_SNAP, status: [], counts: [], log: [] } };
    await render();
    expect(sectionBody("changes")?.textContent).toContain("No uncommitted changes.");
    expect(sectionBody("commits")?.textContent).toContain("No commits yet.");
    expect([...host.querySelectorAll("button")].find(b => b.textContent === "Stage all")).toBeUndefined();
    for (const stub of ["Graph", "Pull requests", "Stashes"]) expect(host.textContent).not.toContain(stub);
  });

  it("waits while git loads and surfaces an error without sections crashing", async () => {
    state = { kind: "loading" };
    await render();
    expect(host.textContent).toContain("Reading git");
    state = { kind: "error", reason: "git is not reachable" };
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("git is not reachable");
  });
});

describe("ahead/behind beside the branch (#14047)", () => {
  it("counts unlanded work when there is no upstream and names the upstream when there is one", async () => {
    await render();
    const ahead = host.querySelector("[data-ahead]");
    expect(ahead?.textContent).toBe("2 unlanded");
    expect(ahead?.getAttribute("title")).toBe("no upstream: ahead counts unlanded work against main");
    state = { kind: "ok", snap: CHECKOUT_SNAP };
    await render();
    expect(host.querySelector("[data-ahead]")?.textContent).toBe("in sync");
    expect(host.querySelector("[data-ahead]")?.getAttribute("title")).toContain("origin/main");
  });

  it("says nothing while git is still loading", async () => {
    state = { kind: "loading" };
    await render();
    expect(host.querySelector("[data-ahead]")).toBeNull();
  });
});

describe("Fetch (#14056)", () => {
  it("spins, fetches the current scope, refreshes counts and remembers the fetch time", async () => {
    let finish: () => void = () => undefined;
    fetchReply = () => new Promise<void>(resolve => { finish = resolve; });
    await render("fetch-success");
    const button = byLabel("Fetch from origin");
    await click(button);
    expect(button?.disabled).toBe(true);
    expect(button?.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");
    await act(async () => { finish(); });
    await flush();
    expect(calls.find(c => c.command === "git_fetch")?.args).toEqual({ project: "fetch-success", agent: "glm-5" });
    expect(mutations).toBe(1);
    expect(button?.disabled).toBe(false);
    expect(host.querySelector("[data-ahead]")?.getAttribute("title")).toContain("fetched 1m ago");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows git's failure and leaves the counts and fetch time alone", async () => {
    fetchReply = () => { throw new Error("fatal: could not resolve host"); };
    await render("fetch-error");
    await click(byLabel("Fetch from origin"));
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("fatal: could not resolve host");
    expect(host.querySelector("[data-ahead]")?.textContent).toBe("2 unlanded");
    expect(host.querySelector("[data-ahead]")?.getAttribute("title")).not.toContain("fetched");
    expect(mutations).toBe(0);
  });
});

describe("Branches and seats (#14047)", () => {
  it("comes after Recent commits with the row count in the badge", async () => {
    await render();
    expect([...host.querySelectorAll("section")].map(s => s.getAttribute("data-section")))
      .toEqual(["changes", "files", "commits", "branches"]);
    const badge = host.querySelector('section[data-section="branches"] [data-count]');
    expect(badge?.textContent).toBe("3");
  });

  it("lists the main checkout and every seat, current row marked, worktree-less seat disabled", async () => {
    await render();
    expect(host.querySelector('button[data-scope-row="main"]')?.textContent).toContain("main checkout");
    expect(host.querySelector('button[data-scope-row="glm-5"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector('button[data-scope-row="main"]')?.getAttribute("aria-pressed")).toBe("false");
    const kimi = host.querySelector<HTMLButtonElement>('button[data-scope-row="kimi-9"]');
    expect(kimi?.disabled).toBe(true);
    expect(kimi?.title).toContain("no worktree");
  });

  it("a row click re-scopes the sidebar: the seat, then back to the checkout", async () => {
    await render();
    await click(host.querySelector('button[data-scope-row="glm-5"]'));
    await click(host.querySelector('button[data-scope-row="main"]'));
    expect(picked).toEqual(["glm-5", null]);
  });
});

describe("headers always on screen (#14058)", () => {
  it("the column does not scroll as a whole; only the open section bodies scroll", async () => {
    await render();
    const column = host.querySelector('section[data-section="changes"]')?.parentElement;
    expect(column?.className).toContain("flex-1");
    expect(column?.className).not.toContain("overflow");
    for (const s of ["changes", "files", "commits", "branches"]) {
      expect(sectionBody(s)?.className).toContain("overflow-y-auto");
    }
  });

  it("with Files open the later headers sit outside the Files body, after it in the column", async () => {
    await render();
    const files = sectionBody("files");
    const commitsHeader = host.querySelector('button[data-section-toggle="commits"]');
    const branchesHeader = host.querySelector('button[data-section-toggle="branches"]');
    expect(commitsHeader).not.toBeNull();
    expect(branchesHeader).not.toBeNull();
    expect(files?.contains(commitsHeader)).toBe(false);
    expect(files?.contains(branchesHeader)).toBe(false);
  });

  it("Files takes the remaining space; the other three stop at 40% of the column", async () => {
    await render();
    expect(host.querySelector('section[data-section="files"]')?.className).toContain("flex-1");
    for (const s of ["changes", "commits", "branches"]) {
      expect(host.querySelector(`section[data-section="${s}"]`)?.className).toContain("max-h-[40%]");
    }
  });

  it("a collapsed section is only its header row and gives the space back", async () => {
    await render();
    await click(host.querySelector('button[data-section-toggle="files"]'));
    const files = host.querySelector('section[data-section="files"]');
    expect(files?.className).toContain("shrink-0");
    expect(files?.className).not.toContain("flex-1");
    expect(sectionBody("files")).toBeNull();
  });

  it("the header row reads as a control: chevron, badge, aria-expanded, Show/Hide title", async () => {
    await render();
    const toggle = host.querySelector<HTMLButtonElement>('button[data-section-toggle="commits"]');
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle?.title).toBe("Hide Recent commits");
    expect(toggle?.querySelector("svg")).not.toBeNull();
    expect(toggle?.querySelector("[data-count]")?.textContent).toBe("2");
    await click(toggle);
    const collapsed = host.querySelector<HTMLButtonElement>('button[data-section-toggle="commits"]');
    expect(collapsed?.getAttribute("aria-expanded")).toBe("false");
    expect(collapsed?.title).toBe("Show Recent commits");
  });
});

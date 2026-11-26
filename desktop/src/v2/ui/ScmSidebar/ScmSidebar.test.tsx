// @vitest-environment happy-dom
// #14044 drill: the source control sidebar's header, change groups, Files, Recent commits,
// remembered sections and clicks; #14047 ahead/behind + seats rows; #14344 one scroller, the
// Changes / Files switch, folded history. Fakes: the Tauri IPC and a per-test localStorage.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { ScmSidebar } from "./index";
import { flatChanges, groupChanges } from "./ChangesSection";
import { readScmSectionOpen, readScmView, writeScmSectionOpen, writeScmView, SCM_KEY_PREFIX } from "./sectionState";
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
const PANEL = { branch: "seat/glm-5", upstream: null, remote: "origin", ahead: 2, behind: null, status: STATUS, counts: [{ path: "bin/a.mjs", plus: 4, minus: 1 }], log: LOG };
const SEAT_SNAP: ScopeSnapshot = { scope: "glm-5", branch: "seat/glm-5", upstream: null, remote: "origin", ahead: 2, behind: null, status: STATUS, counts: [{ path: "bin/a.mjs", plus: 4, minus: 1 }], log: LOG, seatBacked: true, readAt: Date.now() };
const CHECKOUT_SNAP: ScopeSnapshot = { scope: null, branch: "main", upstream: "origin/main", remote: "origin", ahead: 0, behind: 0, status: STATUS, counts: [], log: LOG, seatBacked: false, readAt: Date.now() };
const ROOTS = JSON.stringify([{ name: "README.md", path: "README.md", dir: false, status: "M" }]);
const SEATS: SeatInfo[] = [
  { seat: "glm-5", presence: "working", branch: "seat/glm-5", ahead: 2, machine: null, hasWorktree: true },
  { seat: "kimi-9", presence: "offline", branch: null, ahead: null, machine: "netcup", hasWorktree: false },
];

type IpcArgs = { project?: string; agent?: string; scope?: string; paths?: string[]; unstage?: boolean; message?: string; reference?: string; action?: string };
type Call = { command: string; args: IpcArgs };
let calls: Call[];
type Opened = { file: string[]; change: string[]; commit: string[] };
const opened: Opened = { file: [], change: [], commit: [] };
let picked: (string | null)[];
let fetchReply: (() => void | Promise<void>) | null;
let stashReply: string;
let mutations: number;
let worktreeReply: unknown[];
let conflicts: string[];

let host: HTMLDivElement;
let root: Root;
let state: ScopeState = { kind: "ok", snap: SEAT_SNAP };
beforeEach(() => {
  calls = [];
  opened.file = []; opened.change = []; opened.commit = [];
  picked = [];
  fetchReply = null;
  stashReply = "[]";
  mutations = 0;
  worktreeReply = [];
  conflicts = [];
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
    if (command === "git_discard") return "/Trash/Trantor discard test";
    if (command === "git_stash_list") return stashReply;
    if (command === "git_worktrees") return JSON.stringify(worktreeReply);
    if (command === "git_stash_save" || command === "git_stash_change") return null;
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
const render = async (project = "trantor", scope: string | null = "glm-5", selectedPath: string | null = null) => {
  await act(async () => {
    root.render(<ScmSidebar project={project} scope={scope} scopeName={scope ?? "project checkout"} state={state} seats={SEATS}
      onPickScope={s => picked.push(s)} onMutated={() => { mutations += 1; }} selectedPath={selectedPath}
      onOpenFile={p => opened.file.push(p)} onOpenChange={p => opened.change.push(p)} onOpenCommit={s => opened.commit.push(s)}
      onOpenConflict={p => conflicts.push(p)} />);
  });
  await flush(); await flush();
};
const click = (el: Element | null) => act(async () => { if (el instanceof HTMLElement) el.click(); });
const byLabel = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const sectionBody = (s: string) => host.querySelector(`[data-section-body="${s}"]`);
const openGroup = (s: string) => click(host.querySelector(`button[data-section-toggle="${s}"]`));
const showFiles = () => click([...host.querySelectorAll("button")].find(b => b.textContent === "Files") ?? null);
const typeMessage = async (text: string) => {
  const input = host.querySelector<HTMLInputElement>("#v2-commit-msg");
  await act(async () => {
    if (!input) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("flatChanges and groupChanges", () => {
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

  it("splits Staged from Changes, a path edited after staging sits in both, each with its own side's letter", () => {
    const groups = groupChanges([...STATUS, { path: "both.ts", x: "A", y: "M" }]);
    expect(groups.staged.map(r => [r.path, r.letter])).toEqual([["src/staged.ts", "M"], ["both.ts", "A"]]);
    expect(groups.changes.map(r => [r.path, r.letter])).toEqual([["bin/a.mjs", "M"], ["fresh.ts", "U"], ["src/c.ts", "M"], ["both.ts", "M"]]);
  });
});

describe("section persistence", () => {
  it("defaults open and stores the choice under trantor.v2.scm.<section>", () => {
    expect(readScmSectionOpen("changes")).toBe(true);
    writeScmSectionOpen("changes", false);
    expect(readScmSectionOpen("changes")).toBe(false);
    expect(readScmSectionOpen("files")).toBe(true);
  });

  it("a folded-by-default group stays folded until the operator opens it", () => {
    expect(readScmSectionOpen("commits", false)).toBe(false);
    writeScmSectionOpen("commits", true);
    expect(readScmSectionOpen("commits", false)).toBe(true);
  });

  it("remembers the Changes / Files view under trantor.v2.scm.view", () => {
    expect(readScmView()).toBe("changes");
    writeScmView("files");
    expect(localStorage.getItem(`${SCM_KEY_PREFIX}.view`)).toBe("files");
    expect(readScmView()).toBe("files");
  });
});

describe("the sidebar", () => {
  it("is one header row: state dot, branch, and no uppercase title or section for the files", async () => {
    await render();
    const header = host.querySelector("header");
    expect(header?.textContent).toContain("seat/glm-5");
    expect(host.textContent).not.toContain("Source control");
    expect(host.querySelector("[data-state-dot]")).not.toBeNull();
    expect(sectionBody("changes")).not.toBeNull();
    expect(sectionBody("staged")).not.toBeNull();
    expect(host.querySelector('[role="tree"]')).toBeNull();
  });

  it("names the scope once, in a pill with a way back, and only off the main checkout", async () => {
    await render();
    const pill = host.querySelector("[data-scope-pill]");
    expect(pill?.textContent).toBe("glm-5’s worktree, read only");
    expect(host.querySelectorAll("[data-scope-pill]")).toHaveLength(1);
    await click([...host.querySelectorAll("button")].find(b => b.textContent === "Back to my checkout") ?? null);
    expect(picked).toEqual([null]);
    state = { kind: "ok", snap: CHECKOUT_SNAP };
    await render("trantor", null);
    expect(host.querySelector("[data-scope-pill]")).toBeNull();
    expect([...host.querySelectorAll("button")].find(b => b.textContent === "Back to my checkout")).toBeUndefined();
  });

  it("shows every changed file in its group: Staged first, then Changes with counts, each with a count in the header", async () => {
    await render();
    expect(sectionBody("staged")?.querySelector('[data-change="src/staged.ts"]')).not.toBeNull();
    for (const path of ["bin/a.mjs", "fresh.ts", "src/c.ts"]) {
      expect(sectionBody("changes")?.querySelector(`[data-change="${path}"]`)).not.toBeNull();
    }
    expect(host.querySelector('[data-change="bin/a.mjs"]')?.textContent).toContain("+4");
    expect(byLabel("Stage bin/a.mjs")).not.toBeNull();
    expect(byLabel("Unstage src/staged.ts")).not.toBeNull();
    expect(host.querySelector('[data-section="staged"] [data-count]')?.textContent).toBe("1");
    expect(host.querySelector('[data-section="changes"] [data-count]')?.textContent).toBe("3");
  });

  it("puts the file name first, the folder after it, and the status letter at the far right of a 24px row", async () => {
    await render();
    const row = host.querySelector('[data-change="bin/a.mjs"]');
    expect(row?.className).toContain("h-6");
    const text = row?.querySelector("button")?.textContent ?? "";
    expect(text.indexOf("a.mjs")).toBeLessThan(text.indexOf("bin"));
    expect(row?.lastElementChild?.textContent).toBe("M");
  });

  it("keeps the row actions in a column that is hidden, not removed, until hover", async () => {
    await render();
    const actions = host.querySelector('[data-change="bin/a.mjs"] [data-row-actions]');
    expect(actions?.className).toContain("invisible");
    expect(actions?.className).toContain("group-hover:visible");
    expect(actions?.contains(byLabel("Stage bin/a.mjs"))).toBe(true);
  });

  it("keeps conflict actions protected and offers discard on a seat", async () => {
    await render();
    expect(byLabel("Stage src/c.ts")?.disabled).toBe(true);
    expect(byLabel("Stage src/c.ts")?.title).toContain("conflict record");
    expect(host.querySelector('[data-change="src/c.ts"] button[title="Resolve this conflict"]')).not.toBeNull();
    expect(byLabel("Discard bin/a.mjs")?.disabled).toBe(false);
    expect(byLabel("Discard src/c.ts")?.disabled).toBe(true);
  });

  it("confirms a discard by path before copying to Trash and restoring", async () => {
    await render();
    await click(byLabel("Discard bin/a.mjs"));
    expect(host.querySelector('[data-discard-confirm="bin/a.mjs"]')?.textContent).toContain("dated Trash folder");
    expect(calls.some(c => c.command === "git_discard")).toBe(false);
    await click(host.querySelector('[data-discard-confirm="bin/a.mjs"] button[data-variant="danger"]'));
    expect(calls.find(c => c.command === "git_discard")?.args).toEqual({ project: "trantor", agent: "glm-5", paths: ["bin/a.mjs"] });
  });

  it("keeps Discard all in the group's menu, disabled while a conflict is open", async () => {
    await render();
    expect([...host.querySelectorAll("button")].find(b => b.textContent === "Discard all")).toBeUndefined();
    await click(byLabel("More actions for Changes"));
    const item = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b => b.textContent === "Discard all");
    expect(item?.disabled).toBe(true);
    expect(item?.title).toContain("Resolve conflicts");
  });

  it("Discard all in the menu asks first, then discards the whole scope", async () => {
    state = { kind: "ok", snap: { ...SEAT_SNAP, status: STATUS.filter(e => e.path !== "src/c.ts") } };
    await render();
    await click(byLabel("More actions for Changes"));
    await click([...host.querySelectorAll('[role="menuitem"]')].find(b => b.textContent === "Discard all") ?? null);
    expect(host.querySelector('[data-discard-confirm="all"]')).not.toBeNull();
    expect(calls.some(c => c.command === "git_discard")).toBe(false);
    await click(host.querySelector('[data-discard-confirm="all"] button[data-variant="danger"]'));
    expect(calls.find(c => c.command === "git_discard")?.args).toEqual({ project: "trantor", agent: "glm-5" });
  });

  it("stages and unstages per row through the scope git bridge", async () => {
    await render();
    await click(byLabel("Stage bin/a.mjs"));
    expect(calls.find(c => c.command === "git_stage")?.args).toEqual({ project: "trantor", agent: "glm-5", paths: ["bin/a.mjs"], unstage: false });
    await click(byLabel("Unstage src/staged.ts"));
    expect(calls.filter(c => c.command === "git_stage")[1]?.args).toEqual({ project: "trantor", agent: "glm-5", paths: ["src/staged.ts"], unstage: true });
  });

  it("Stage all batches every non-conflicted change in one call, Unstage all the whole Staged group", async () => {
    await render();
    await click([...host.querySelectorAll("button")].find(b => b.textContent === "Stage all") ?? null);
    expect(calls.find(c => c.command === "git_stage")?.args).toEqual({ project: "trantor", agent: "glm-5", paths: ["bin/a.mjs", "fresh.ts"], unstage: false });
    await click([...host.querySelectorAll("button")].find(b => b.textContent === "Unstage all") ?? null);
    expect(calls.filter(c => c.command === "git_stage")[1]?.args).toEqual({ project: "trantor", agent: "glm-5", paths: ["src/staged.ts"], unstage: true });
  });

  it("hides the Staged group while nothing is staged", async () => {
    state = { kind: "ok", snap: { ...SEAT_SNAP, status: [{ path: "bin/a.mjs", x: " ", y: "M" }] } };
    await render();
    expect(host.querySelector('[data-section="staged"]')).toBeNull();
    expect(sectionBody("changes")).not.toBeNull();
  });

  it("commits through the bridge with the staged count", async () => {
    await render();
    await typeMessage("#14044 land it");
    await click([...host.querySelectorAll("button")].find(b => b.textContent?.includes("Commit 1 file")) ?? null);
    await flush();
    expect(calls.find(c => c.command === "git_commit")?.args).toEqual({ project: "trantor", agent: "glm-5", message: "#14044 land it" });
  });

  it("on the main checkout the refusal travels with the discard and the commit button never names the branch", async () => {
    state = { kind: "ok", snap: CHECKOUT_SNAP };
    await render("trantor", null);
    const commit = [...host.querySelectorAll("button")].find(b => b.textContent?.includes("Commit 1 file"));
    expect(commit).toBeDefined();
    expect(commit?.textContent).not.toContain("main");
    expect(host.querySelector("[data-main-checkout]")).toBeNull();
    expect(byLabel("Discard bin/a.mjs")?.title).toContain("orchestrator");
  });

  it("collapses one group, remembers it across a remount, and reopens", async () => {
    await render();
    await openGroup("changes");
    expect(sectionBody("changes")).toBeNull();
    expect(sectionBody("staged")).not.toBeNull();
    expect(localStorage.getItem(`${SCM_KEY_PREFIX}.changes`)).toBe("false");
    await render();
    expect(sectionBody("changes")).toBeNull();
    await openGroup("changes");
    expect(sectionBody("changes")).not.toBeNull();
    expect(localStorage.getItem(`${SCM_KEY_PREFIX}.changes`)).toBe("true");
  });

  it("a changed file, a commit and a file each reach the host", async () => {
    await render();
    await click(host.querySelector('button[title="Show the diff for bin/a.mjs"]'));
    expect(opened.change).toEqual(["bin/a.mjs"]);
    await openGroup("commits");
    await click(host.querySelector('[data-sha="abc1234def"]'));
    expect(opened.commit).toEqual(["abc1234def"]);
    await showFiles();
    await flush();
    await click(host.querySelector('[role="treeitem"][data-path="README.md"]'));
    expect(opened.file).toEqual(["README.md"]);
  });

  it("empty git data says so instead of stub sections", async () => {
    state = { kind: "ok", snap: { ...SEAT_SNAP, status: [], counts: [], log: [] } };
    await render();
    expect(host.textContent).toContain("Nothing to commit");
    expect(host.querySelector('[data-section="changes"]')).toBeNull();
    await openGroup("commits");
    await openGroup("stashes");
    expect(sectionBody("commits")?.textContent).toContain("No commits yet.");
    expect([...host.querySelectorAll("button")].find(b => b.textContent === "Stage all")).toBeUndefined();
    expect(host.textContent).toContain("No stashes.");
    for (const stub of ["Graph", "Pull requests"]) expect(host.textContent).not.toContain(stub);
  });

  it("waits while git loads and surfaces an error without sections crashing", async () => {
    state = { kind: "loading" };
    await render();
    expect(host.textContent).toContain("Reading git");
    state = { kind: "error", reason: "git is not reachable" };
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("git is not reachable");
  });

  it("marks the row of the change the host is showing as selected", async () => {
    await render("trantor", "glm-5", "bin/a.mjs");
    expect(host.querySelector('[data-change="bin/a.mjs"]')?.getAttribute("data-selected")).toBe("true");
    expect(host.querySelector('[data-change="fresh.ts"]')?.hasAttribute("data-selected")).toBe(false);
  });
});

describe("the Changes / Files switch (#14344)", () => {
  it("starts on Changes, switches to a full-height Files view with its toolbar in the header, and remembers it", async () => {
    await render();
    const switcher = host.querySelector('[role="group"][aria-label="Source control view"]');
    expect(switcher?.querySelector('button[aria-pressed="true"]')?.textContent).toBe("Changes");
    expect(host.querySelector('[role="tree"]')).toBeNull();
    await showFiles();
    await flush();
    expect(host.querySelector('[role="tree"]')).not.toBeNull();
    expect(sectionBody("changes")).toBeNull();
    expect(host.querySelector("[data-files-toolbar]")?.contains(byLabel("New file"))).toBe(true);
    expect(localStorage.getItem(`${SCM_KEY_PREFIX}.view`)).toBe("files");
    await render();
    expect(host.querySelector('[role="tree"]')).not.toBeNull();
  });

  it("marks the open file's row selected in the tree, with the status letter at the right", async () => {
    await render("trantor", "glm-5", "README.md");
    await showFiles();
    await flush();
    const row = host.querySelector('[role="treeitem"][data-path="README.md"]');
    expect(row?.getAttribute("data-selected")).toBe("true");
    expect(row?.className).toContain("h-6");
    expect(row?.lastElementChild?.getAttribute("data-letter")).toBe("M");
  });
});

describe("what needs you comes first (#14344)", () => {
  const READY = { path: "/repo/.claude/worktrees/agent-a3b04308faa", branch: "wt", head: "a", locked: false, kind: "agent", last_activity: Math.floor(Date.now() / 1000) - 3600, changed: 3, ahead: 1, files: [] };

  it("says files are in conflict and Resolve opens the first one in the merge view", async () => {
    await render();
    const note = host.querySelector('[data-note="conflicts"]');
    expect(note?.textContent).toContain("1 file is in conflict");
    await click(note?.querySelector("button") ?? null);
    expect(conflicts).toEqual(["src/c.ts"]);
  });

  it("offers no note while nothing is in conflict and no agent has work waiting", async () => {
    state = { kind: "ok", snap: { ...SEAT_SNAP, status: [{ path: "bin/a.mjs", x: " ", y: "M" }] } };
    await render();
    expect(host.querySelector("[role=note]")).toBeNull();
  });

  it("names an agent whose finished work waits in its worktree, and Review reads that worktree", async () => {
    worktreeReply = [READY];
    state = { kind: "ok", snap: CHECKOUT_SNAP };
    await render("trantor", null);
    const note = host.querySelector('[data-note="ready"]');
    expect(note?.textContent).toContain("agent a3b0430 has 3 files ready in its worktree");
    await click([...note?.querySelectorAll("button") ?? []].find(b => b.textContent === "Review") ?? null);
    expect(picked).toEqual(["wt:/repo/.claude/worktrees/agent-a3b04308faa"]);
  });

  it("does not nag about a worktree that is still working", async () => {
    worktreeReply = [{ ...READY, locked: true }];
    state = { kind: "ok", snap: CHECKOUT_SNAP };
    await render("trantor", null);
    expect(host.querySelector('[data-note="ready"]')).toBeNull();
  });
});

describe("ahead/behind beside the branch (#14047)", () => {
  it("shows arrows in accent when ahead, and says the upstream or the unlanded rule in the tooltip", async () => {
    await render();
    const ahead = host.querySelector("[data-ahead]");
    expect(ahead?.textContent).toBe("↑2");
    expect(ahead?.getAttribute("title")).toBe("no upstream: ahead counts unlanded work against main");
    expect(host.querySelector("[data-state-dot]")?.getAttribute("data-tone")).toBe("accent");
  });

  it("shows nothing when in sync, the dot goes ok and its tooltip says in sync with the upstream", async () => {
    state = { kind: "ok", snap: CHECKOUT_SNAP };
    await render("trantor", null);
    expect(host.querySelector("[data-ahead]")).toBeNull();
    expect(host.querySelector("[data-state-dot]")?.getAttribute("data-tone")).toBe("ok");
    expect(host.querySelector("[data-state-dot]")?.getAttribute("title")).toBe("in sync with origin/main");
  });

  it("shows both arrows with an upstream and warns when behind", async () => {
    state = { kind: "ok", snap: { ...CHECKOUT_SNAP, ahead: 2, behind: 1 } };
    await render("trantor", null);
    expect(host.querySelector("[data-ahead]")?.textContent).toBe("↑2 ↓1");
    expect(host.querySelector("[data-ahead]")?.getAttribute("title")).toContain("origin/main");
    expect(host.querySelector("[data-state-dot]")?.getAttribute("data-tone")).toBe("warn");
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

  it("shows a plain git failure and leaves the counts and fetch time alone", async () => {
    fetchReply = () => { throw new Error("fatal: Remote is unavailable\nDiagnostic detail"); };
    await render("fetch-error");
    await click(byLabel("Fetch from origin"));
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Remote is unavailable");
    expect(host.querySelector("[data-ahead]")?.textContent).toBe("↑2");
    expect(host.querySelector("[data-ahead]")?.getAttribute("title")).not.toContain("fetched");
    expect(mutations).toBe(0);
  });
});

describe("Stashes (#14099)", () => {
  it("saves with a message and pops the selected stash through the scoped bridge", async () => {
    stashReply = JSON.stringify([{ name: "stash@{0}", sha: "abcdef123456", created_at: 1_700_000_000, message: "work in progress" }]);
    await render();
    await openGroup("stashes");
    expect(host.querySelector('[data-stash="stash@{0}"]')?.textContent).toContain("work in progress");
    const input = host.querySelector<HTMLInputElement>("#v2-stash-message");
    await act(async () => {
      if (!input) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "new stash");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click([...host.querySelectorAll("button")].find(b => b.textContent === "Stash") ?? null);
    await flush();
    expect(calls.find(c => c.command === "git_stash_save")?.args).toEqual({ project: "trantor", agent: "glm-5", message: "new stash" });
    await click([...host.querySelectorAll("button")].find(b => b.textContent === "Pop") ?? null);
    await flush();
    expect(calls.find(c => c.command === "git_stash_change")?.args).toEqual({ project: "trantor", agent: "glm-5", reference: "stash@{0}", action: "pop" });
  });
});

describe("Branches and seats (#14047)", () => {
  it("comes after Recent commits, folded, with the row count in the header", async () => {
    await render();
    expect([...host.querySelectorAll("section")].map(s => s.getAttribute("data-section")))
      .toEqual(["staged", "changes", "commits", "stashes", "branches"]);
    expect(sectionBody("branches")).toBeNull();
    const badge = host.querySelector('section[data-section="branches"] [data-count]');
    expect(badge?.textContent).toBe("3");
  });

  it("lists the main checkout and every seat, current row marked, worktree-less seat disabled", async () => {
    await render();
    await openGroup("branches");
    expect(host.querySelector('button[data-scope-row="main"]')?.textContent).toContain("main checkout");
    expect(host.querySelector('button[data-scope-row="glm-5"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector('button[data-scope-row="main"]')?.getAttribute("aria-pressed")).toBe("false");
    const kimi = host.querySelector<HTMLButtonElement>('button[data-scope-row="kimi-9"]');
    expect(kimi?.disabled).toBe(true);
    expect(kimi?.title).toContain("no worktree");
  });

  it("a row click re-scopes the sidebar: the seat, then back to the checkout", async () => {
    await render();
    await openGroup("branches");
    await click(host.querySelector('button[data-scope-row="glm-5"]'));
    await click(host.querySelector('button[data-scope-row="main"]'));
    expect(picked).toEqual(["glm-5", null]);
  });
});

describe("one scroller, history folded (#14344)", () => {
  it("scrolls the whole column in one place; no group body scrolls inside itself", async () => {
    await render();
    const scrollers = host.querySelectorAll('[class*="overflow-y-auto"]');
    expect(host.querySelectorAll("[data-scm-scroller]")).toHaveLength(1);
    expect(host.querySelector("[data-scm-scroller]")?.className).toContain("overflow-y-auto");
    for (const el of scrollers) expect(el.hasAttribute("data-section-body")).toBe(false);
  });

  it("folds Recent commits, Stashes and Branches and seats by default and keeps the work groups open", async () => {
    await render();
    for (const open of ["staged", "changes"]) expect(sectionBody(open)).not.toBeNull();
    for (const folded of ["commits", "stashes", "branches"]) {
      expect(host.querySelector(`button[data-section-toggle="${folded}"]`)?.getAttribute("aria-expanded")).toBe("false");
      expect(sectionBody(folded)).toBeNull();
    }
  });

  it("opens a folded group inline and remembers it", async () => {
    await render();
    await openGroup("commits");
    expect(sectionBody("commits")?.querySelectorAll("[data-sha]")).toHaveLength(2);
    expect(localStorage.getItem(`${SCM_KEY_PREFIX}.commits`)).toBe("true");
    await render();
    expect(sectionBody("commits")).not.toBeNull();
  });

  it("the header row reads as a control: caret, count, aria-expanded, Show/Hide title, 26px", async () => {
    await render();
    await openGroup("commits");
    const toggle = host.querySelector<HTMLButtonElement>('button[data-section-toggle="commits"]');
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle?.title).toBe("Hide Recent commits");
    expect(toggle?.querySelector("svg")?.getAttribute("style")).toContain("rotate(90deg)");
    expect(toggle?.querySelector("[data-count]")?.textContent).toBe("2");
    expect(toggle?.parentElement?.className).toContain("h-[26px]");
    await click(toggle);
    const collapsed = host.querySelector<HTMLButtonElement>('button[data-section-toggle="commits"]');
    expect(collapsed?.getAttribute("aria-expanded")).toBe("false");
    expect(collapsed?.title).toBe("Show Recent commits");
  });
});

describe("Controls a developer expects (#14268)", () => {
  const stash = [{ name: "stash@{0}", sha: "abcdef123456", created_at: 1_700_000_000, message: "wip" }];
  const dropButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="Drop stash@{0}"]');
  const confirmBox = () => host.querySelector("[data-stash-drop-confirm]");
  const key = (el: Element | null, k: string) => act(async () => { el?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });

  it("asks before dropping a stash, and Cancel keeps it", async () => {
    stashReply = JSON.stringify(stash);
    await render();
    await openGroup("stashes");
    await click(dropButton());
    expect(confirmBox()?.textContent).toContain("stash@{0}");
    expect(calls.find(c => c.command === "git_stash_change")).toBeUndefined();
    await click([...confirmBox()?.querySelectorAll("button") ?? []].find(b => b.textContent === "Cancel") ?? null);
    expect(confirmBox()).toBeNull();
    expect(calls.find(c => c.command === "git_stash_change")).toBeUndefined();
  });

  it("drops only after the confirm click, and Escape closes the question", async () => {
    stashReply = JSON.stringify(stash);
    await render();
    await openGroup("stashes");
    await click(dropButton());
    await key(document.body, "Escape");
    expect(confirmBox()).toBeNull();
    await click(dropButton());
    await click([...confirmBox()?.querySelectorAll("button") ?? []].find(b => b.textContent === "Drop stash@{0}") ?? null);
    await flush();
    expect(calls.find(c => c.command === "git_stash_change")?.args).toMatchObject({ reference: "stash@{0}", action: "drop" });
  });

  it("Enter in the stash message box stashes", async () => {
    await render();
    await openGroup("stashes");
    const input = host.querySelector<HTMLInputElement>("#v2-stash-message");
    await act(async () => {
      if (!input) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "from keyboard");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await key(input, "Enter");
    await flush();
    expect(calls.find(c => c.command === "git_stash_save")?.args).toMatchObject({ message: "from keyboard" });
  });

  it("Space on a change row stages it, and Space on a staged row unstages it", async () => {
    await render();
    await key(host.querySelector('[data-change="bin/a.mjs"] button'), " ");
    await flush();
    expect(calls.filter(c => c.command === "git_stage").pop()?.args).toMatchObject({ paths: ["bin/a.mjs"], unstage: false });
    await key(host.querySelector('[data-change="src/staged.ts"] button'), " ");
    await flush();
    expect(calls.filter(c => c.command === "git_stage").pop()?.args).toMatchObject({ paths: ["src/staged.ts"], unstage: true });
  });

  it("Space on a conflicted row stages nothing", async () => {
    await render();
    await key(host.querySelector('[data-change="src/c.ts"] button'), " ");
    await flush();
    expect(calls.find(c => c.command === "git_stage")).toBeUndefined();
  });

  it("Delete on a change row asks to discard it, and discards nothing until confirmed", async () => {
    await render();
    await key(host.querySelector('[data-change="bin/a.mjs"] button'), "Delete");
    expect(host.querySelector('[data-discard-confirm="bin/a.mjs"]')).not.toBeNull();
    expect(calls.find(c => c.command === "git_discard")).toBeUndefined();
  });

  it("Delete on a conflicted row discards nothing and asks nothing", async () => {
    await render();
    await key(host.querySelector('[data-change="src/c.ts"] button'), "Delete");
    expect(host.querySelector("[data-discard-confirm]")).toBeNull();
  });

  it("Escape closes the discard question without discarding", async () => {
    await render();
    await click(byLabel("Discard bin/a.mjs"));
    expect(host.querySelector("[data-discard-confirm]")).not.toBeNull();
    await key(document.body, "Escape");
    expect(host.querySelector("[data-discard-confirm]")).toBeNull();
    expect(calls.find(c => c.command === "git_discard")).toBeUndefined();
  });

  it("Cmd+Enter in the commit box commits the staged files", async () => {
    await render();
    await typeMessage("keyboard commit");
    await key(host.querySelector("#v2-commit-msg"), "Enter");
    expect(calls.find(c => c.command === "git_commit")).toBeUndefined();
    await act(async () => { host.querySelector("#v2-commit-msg")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })); });
    await flush();
    expect(calls.find(c => c.command === "git_commit")?.args).toMatchObject({ message: "keyboard commit" });
  });
});

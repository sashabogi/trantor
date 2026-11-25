// @vitest-environment happy-dom
// #13987 drill: the Explorer shows git status letters, tinted names and folder dots, in both screens that use it.
// Fakes sit at the Tauri IPC only; localStorage is a fresh in-memory store per test.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { HubClient } from "../../shared/api/client";
import { FilesColumn } from "../screens/Workspace/FilesColumn";
import { FILES_OPEN_KEY, useFilesColumn } from "../screens/Workspace/chatColumnState";
import { Sidebar } from "../screens/Code/Sidebar";
import { ExplorerTree } from "./ExplorerTree";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Args = { project?: string; sub?: string | null; agent?: string; scope?: string; path?: string };
const ROOT = [
  { name: "src", path: "src", dir: true, status: "" },
  { name: "docs", path: "docs", dir: true, status: "" },
  { name: "README.md", path: "README.md", dir: false, status: "M" },
  { name: "old.txt", path: "old.txt", dir: false, status: "D" },
  { name: "fresh.ts", path: "fresh.ts", dir: false, status: "??" },
  { name: "clean.ts", path: "clean.ts", dir: false, status: "" },
];
const SRC = [{ name: "a.ts", path: "src/a.ts", dir: false, status: "A" }, { name: "b.ts", path: "src/b.ts", dir: false, status: "" }];
const PANEL = {
  branch: "main", upstream: null, ahead: null, behind: null, log: [],
  status: [
    { path: "README.md", x: " ", y: "M" }, { path: "old.txt", x: " ", y: "D" }, { path: "fresh.ts", x: "?", y: "?" },
    { path: "src/a.ts", x: "A", y: " " }, { path: "src/c.ts", x: "U", y: "U" }, { path: "docs/x.md", x: "M", y: "M" },
  ],
  counts: [{ path: "README.md", plus: 12, minus: 3 }],
};

let calls: { command: string; args: Args }[];
let host: HTMLDivElement;
let root: Root;
let panelFails = false;
beforeEach(() => {
  calls = [];
  panelFails = false;
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
  mockIPC((command, payload) => {
    // SAFETY: mockIPC types payload as unknown; these commands are invoked with an object of named args.
    const args = (payload ?? {}) as Args;
    calls.push({ command, args });
    if (command === "project_files") return JSON.stringify(args.sub === "src" ? SRC : args.sub ? [] : ROOT);
    if (command === "git_panel") { if (panelFails) throw new Error("git is not reachable"); return JSON.stringify(PANEL); }
    if (command === "plugin:event|listen") return 1;
    return null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); clearMocks(); vi.unstubAllGlobals(); });

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });
const mount = async (opened: string[] = [], seat: string | null = null) => {
  await act(async () => { root.render(<ExplorerTree project="trantor" seat={seat} onOpen={p => opened.push(p)} />); });
  await flush();
};
const item = (path: string) => host.querySelector<HTMLElement>(`[role="treeitem"][data-path="${path}"]`);
const press = (el: Element | null, key: string) => act(async () => { el?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
const click = (el: Element | null) => act(async () => { if (el instanceof HTMLElement) el.click(); });

describe("decorations", () => {
  it("shows a letter in its tone, a tinted name and a muted line count at the right of a changed file", async () => {
    await mount();
    const readme = item("README.md");
    expect(readme?.querySelector("[data-letter]")?.textContent).toBe("M");
    expect(readme?.querySelector<HTMLElement>("[data-letter]")?.style.color).toBe("var(--v2-warn)");
    expect(readme?.querySelector<HTMLElement>("[data-name]")?.style.color).toBe("var(--v2-warn)");
    expect(readme?.querySelector("[data-counts]")?.textContent).toBe("+12 −3");
    expect(readme?.title).toBe("README.md — Modified, not staged · +12 −3");
  });

  it("tells every kind apart by letter, and strikes a deleted name through", async () => {
    await mount();
    expect(item("fresh.ts")?.querySelector("[data-letter]")?.textContent).toBe("U");
    expect(item("old.txt")?.querySelector("[data-letter]")?.textContent).toBe("D");
    expect(item("old.txt")?.querySelector("[data-name]")?.className).toContain("line-through");
    expect(item("old.txt")?.querySelector<HTMLElement>("[data-name]")?.style.color).toBe("var(--v2-bad)");
  });

  it("leaves an unchanged file as it was: no letter, no counts, plain title", async () => {
    await mount();
    expect(item("clean.ts")?.querySelector("[data-letter]")).toBeNull();
    expect(item("clean.ts")?.querySelector("[data-counts]")).toBeNull();
    expect(item("clean.ts")?.title).toBe("clean.ts");
  });

  it("puts a dot on a folder in the tone of the most important change inside, with a count tooltip", async () => {
    await mount();
    const src = item("src");
    expect(src?.querySelector("[data-folder-dot]")?.getAttribute("data-folder-dot")).toBe("bad");
    expect(src?.title).toBe("src — 2 changed files inside");
    expect(src?.querySelector<HTMLElement>("[data-name]")?.style.color).toBe("var(--v2-bad)");
    expect(item("docs")?.querySelector("[data-folder-dot]")?.getAttribute("data-folder-dot")).toBe("warn");
    expect(item("docs")?.title).toBe("docs — 1 changed file inside");
  });

  it("falls back to the listing's own codes when git status cannot be read", async () => {
    panelFails = true;
    await mount();
    expect(item("README.md")?.querySelector("[data-letter]")?.textContent).toBe("M");
    expect(item("fresh.ts")?.querySelector("[data-letter]")?.textContent).toBe("U");
  });

  it("asks for the seat's own worktree when a seat is chosen", async () => {
    await mount([], "codex-8");
    expect(calls.find(c => c.command === "git_panel")?.args.agent).toBe("codex-8");
    expect(calls.find(c => c.command === "project_files")?.args).toMatchObject({ seat: "codex-8" });
  });
});

describe("legend", () => {
  it("opens from the ? button and explains each letter in a sentence", async () => {
    await mount();
    expect(host.querySelector('[aria-label="Git status legend"][role="menu"]')).toBeNull();
    const help = host.querySelector<HTMLButtonElement>('button[aria-label="Git status legend"]');
    expect(help?.title).not.toBe("");
    await click(help);
    const menu = host.querySelector('[role="menu"][aria-label="Git status legend"]');
    expect(menu?.textContent).toContain("Untracked: a new file git is not tracking yet");
    for (const l of ["M", "A", "U", "D", "R", "!"]) expect(menu?.querySelector(`[data-legend="${l}"]`)).not.toBeNull();
  });
});

describe("behaviour", () => {
  it("opens a file on click and on Enter", async () => {
    const opened: string[] = [];
    await mount(opened);
    await click(item("README.md"));
    await press(item("fresh.ts"), "Enter");
    expect(opened).toEqual(["README.md", "fresh.ts"]);
  });

  it("is a tree: treeitems with aria-expanded on folders, arrows move, Right expands, Left collapses", async () => {
    await mount();
    expect(host.querySelector('[role="tree"]')).not.toBeNull();
    expect(item("src")?.getAttribute("aria-expanded")).toBe("false");
    expect(item("README.md")?.hasAttribute("aria-expanded")).toBe(false);
    item("src")?.focus();
    await press(item("src"), "ArrowDown");
    expect(document.activeElement).toBe(item("docs"));
    await press(item("docs"), "ArrowUp");
    expect(document.activeElement).toBe(item("src"));
    await press(item("src"), "ArrowRight");
    await flush();
    expect(item("src")?.getAttribute("aria-expanded")).toBe("true");
    expect(item("src/a.ts")?.querySelector("[data-letter]")?.textContent).toBe("A");
    await press(item("src"), "ArrowLeft");
    expect(item("src/a.ts")).toBeNull();
  });

  it("remembers expanded folders per project and checkout", async () => {
    await mount();
    await click(item("src"));
    await flush();
    expect(JSON.parse(localStorage.getItem("trantor.v2.explorer.expanded.trantor.project") ?? "[]")).toEqual(["src"]);
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await mount();
    expect(item("src/a.ts")).not.toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await mount([], "codex-8");
    expect(item("src/a.ts")).toBeNull();
  });

  it("creates a new file through the New file button, guarded against escaping the project", async () => {
    await mount();
    await click(host.querySelector('button[aria-label="New file"]'));
    const input = host.querySelector<HTMLInputElement>('input[aria-label="file name"]');
    if (!input) throw new Error("no name input");
    input.value = "src/new.ts";
    await press(input, "Enter");
    await flush();
    expect(calls.find(c => c.command === "create_file")?.args).toMatchObject({ project: "trantor", path: "src/new.ts", seat: null });

    await click(host.querySelector('button[aria-label="New file"]'));
    const bad = host.querySelector<HTMLInputElement>('input[aria-label="file name"]');
    if (!bad) throw new Error("no name input");
    bad.value = "../escape.ts";
    await press(bad, "Enter");
    await flush();
    expect(calls.filter(c => c.command === "create_file")).toHaveLength(1);
    expect(host.textContent).toContain("path escapes the project");
  });

  it("renames and deletes from the row menu with the classic calls", async () => {
    vi.stubGlobal("confirm", () => true);
    await mount();
    await act(async () => { item("clean.ts")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    const menu = host.querySelector('[role="menu"][aria-label="Actions for clean.ts"]');
    expect([...(menu?.querySelectorAll("button") ?? [])].map(b => b.textContent)).toEqual(["New file", "Rename", "Delete"]);
    await click([...(menu?.querySelectorAll("button") ?? [])].find(b => b.textContent === "Delete") ?? null);
    await flush();
    expect(calls.find(c => c.command === "delete_file")?.args).toMatchObject({ path: "clean.ts" });
    await press(item("clean.ts"), "F2");
    const input = host.querySelector<HTMLInputElement>('input[aria-label="New name"]');
    if (!input) throw new Error("no rename input");
    input.value = "tidy.ts";
    await press(input, "Enter");
    await flush();
    expect(calls.find(c => c.command === "rename_file")?.args).toMatchObject({ oldPath: "clean.ts", newPath: "tidy.ts" });
  });
});

describe("both screens use it", () => {
  it("the Workspace Files column renders the new tree", async () => {
    localStorage.setItem(FILES_OPEN_KEY, "true");
    const ref = { current: null };
    function Column() {
      const col = useFilesColumn();
      return <FilesColumn col={col} workspace={ref} project="trantor" scope={null} scopeName="project checkout"
        onOpenFile={() => undefined} onOpenChange={() => undefined} onOpenCommit={() => undefined} />;
    }
    await act(async () => { root.render(<Column />); });
    await flush();
    expect(host.querySelector('[role="tree"]')).not.toBeNull();
    expect(item("README.md")?.querySelector("[data-letter]")?.textContent).toBe("M");
    expect(host.textContent).not.toContain("changed");
  });

  it("the Code Explorer sidebar renders the new tree", async () => {
    const client = new HubClient("http://hub.test", async () => ({ status: 200, body: JSON.stringify({ tasks: [] }) }));
    await act(async () => {
      root.render(<Sidebar view="explorer" client={client} project="trantor" scope={null} seats={[]} state={{ kind: "loading" }} selected={null}
        onOpenFile={() => undefined} onOpenChange={() => undefined} onOpenCommit={() => undefined} onMutated={() => undefined}
        onOpenSource={() => undefined} onPickSeat={() => undefined} onOpenConflict={() => undefined} />);
    });
    await flush();
    expect(host.querySelector('[role="tree"]')).not.toBeNull();
    expect(item("fresh.ts")?.querySelector("[data-letter]")?.textContent).toBe("U");
  });
});

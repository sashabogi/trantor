// @vitest-environment happy-dom
// #14106: the Explorer's move, copy path, reveal, and folder rename and delete. Fakes sit at the Tauri IPC only.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { ExplorerTree } from "./ExplorerTree";
import { folderDeleteQuestion } from "./useExplorerOps";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Args = { sub?: string | null; path?: string; from?: string; to?: string; seat?: string | null };
const ROOT = [
  { name: "src", path: "src", dir: true, status: "" },
  { name: "docs", path: "docs", dir: true, status: "" },
  { name: "README.md", path: "README.md", dir: false, status: "" },
];
const DOCS = [{ name: "x.md", path: "docs/x.md", dir: false, status: "" }];
const PANEL = { branch: "main", upstream: null, ahead: null, behind: null, log: [], status: [], counts: [] };

let calls: { command: string; args: Args }[];
let host: HTMLDivElement;
let root: Root;
let copied: string[];
let asked: string[];
let answer: boolean;
beforeEach(() => {
  calls = []; copied = []; asked = []; answer = true;
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); }, clear: () => mem.clear(), key: () => null, length: 0,
  });
  vi.stubGlobal("navigator", { clipboard: { writeText: async (t: string) => { copied.push(t); } } });
  vi.stubGlobal("confirm", (q: string) => { asked.push(q); return answer; });
  mockIPC((command, payload) => {
    // SAFETY: mockIPC types payload as unknown; these commands are invoked with an object of named args.
    const args = (payload ?? {}) as Args;
    calls.push({ command, args });
    if (command === "project_files") return JSON.stringify(args.sub === "docs" ? DOCS : args.sub ? [] : ROOT);
    if (command === "git_panel") return JSON.stringify(PANEL);
    if (command === "absolute_path") return `/work/trantor/${args.path}`;
    if (command === "count_folder_files") return 3;
    if (command === "plugin:event|listen") return 1;
    return null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); clearMocks(); vi.unstubAllGlobals(); });

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });
const mount = async (seat: string | null = null) => {
  await act(async () => { root.render(<ExplorerTree project="trantor" seat={seat} onOpen={() => undefined} />); });
  await flush();
};
const item = (path: string) => host.querySelector<HTMLElement>(`[role="treeitem"][data-path="${path}"]`);
const click = (el: Element | null) => act(async () => { if (el instanceof HTMLElement) el.click(); });
const press = (el: Element | null, key: string) => act(async () => { el?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
const fire = (el: Element | null, type: string) => act(async () => { el?.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })); });
const choose = async (path: string, name: string) => {
  await act(async () => { item(path)?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  const menu = host.querySelector(`[role="menu"][aria-label="Actions for ${path}"]`);
  await click([...(menu?.querySelectorAll("button") ?? [])].find(b => b.textContent === name) ?? null);
  await flush();
};
const call = (command: string) => calls.find(c => c.command === command);

describe("row menu", () => {
  it("copies the relative path as given and the absolute path from the native side", async () => {
    await mount();
    await choose("README.md", "Copy relative path");
    expect(copied).toEqual(["README.md"]);
    await choose("README.md", "Copy path");
    expect(call("absolute_path")?.args).toMatchObject({ path: "README.md", seat: null });
    expect(copied).toEqual(["README.md", "/work/trantor/README.md"]);
  });

  it("reveals in Finder, scoped to the seat's worktree when a seat is chosen", async () => {
    await mount("codex-8");
    await choose("README.md", "Reveal in Finder");
    expect(call("reveal_path")?.args).toMatchObject({ path: "README.md", seat: "codex-8" });
  });

  it("moves through the picker: choose a folder, then Move here", async () => {
    await mount();
    await choose("README.md", "Move to");
    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("project root");
    await click(dialog?.querySelector('[data-folder="docs"]') ?? null);
    await flush();
    expect(dialog?.querySelector("[data-current]")?.textContent).toBe("docs");
    await click([...(dialog?.querySelectorAll("button") ?? [])].find(b => b.textContent === "Move here") ?? null);
    await flush();
    expect(call("move_path")?.args).toMatchObject({ from: "README.md", to: "docs/README.md" });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps Move here off while the folder is the file's own", async () => {
    await mount();
    await choose("README.md", "Move to");
    const here = [...host.querySelectorAll("button")].find(b => b.textContent === "Move here");
    expect(here?.disabled).toBe(true);
    expect(here?.title).not.toBe("");
  });
});

describe("drag and drop", () => {
  it("dropping a row on a folder moves it there", async () => {
    await mount();
    await fire(item("README.md"), "dragstart");
    await fire(item("docs"), "dragover");
    expect(item("docs")?.getAttribute("data-drop-over")).toBe("true");
    await fire(item("docs"), "drop");
    await flush();
    expect(call("move_path")?.args).toMatchObject({ from: "README.md", to: "docs/README.md" });
  });

  it("dropping on a file row or on its own folder moves nothing", async () => {
    await mount();
    await fire(item("README.md"), "dragstart");
    await fire(item("README.md"), "drop");
    await fire(item("src"), "dragstart");
    await fire(item("src"), "drop");
    await flush();
    expect(call("move_path")).toBeUndefined();
  });

  it("the header takes a drop and moves the row to the project root", async () => {
    await mount();
    await click(item("docs"));
    await flush();
    await fire(item("docs/x.md"), "dragstart");
    await fire(host.querySelector("[data-root-drop]"), "drop");
    await flush();
    expect(call("move_path")?.args).toMatchObject({ from: "docs/x.md", to: "x.md" });
  });
});

describe("folders", () => {
  it("renames a folder with the folder command, not the file one", async () => {
    await mount();
    await press(item("src"), "F2");
    const input = host.querySelector<HTMLInputElement>('input[aria-label="New name"]');
    if (!input) throw new Error("no rename input");
    input.value = "lib";
    await press(input, "Enter");
    await flush();
    expect(call("rename_folder")?.args).toMatchObject({ from: "src", to: "lib" });
    expect(call("rename_file")).toBeUndefined();
  });

  it("says how many files are inside before deleting, then deletes", async () => {
    await mount();
    await choose("src", "Delete");
    expect(asked).toEqual([folderDeleteQuestion("src", 3)]);
    expect(asked[0]).toContain("3 files");
    expect(call("delete_folder")?.args).toMatchObject({ path: "src" });
    expect(call("delete_file")).toBeUndefined();
  });

  it("deletes nothing when the question is declined", async () => {
    answer = false;
    await mount();
    await press(item("docs"), "Delete");
    await flush();
    expect(asked).toHaveLength(1);
    expect(call("delete_folder")).toBeUndefined();
  });

  it("words the question for an empty folder and for one file", () => {
    expect(folderDeleteQuestion("a", 0)).toContain("It is empty.");
    expect(folderDeleteQuestion("a", 1)).toContain("It holds 1 file.");
  });
});

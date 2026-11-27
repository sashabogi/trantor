// @vitest-environment happy-dom
// #14072: the file document reports clean and dirty for the tab's dot, saves plainly and calls
// onSaved only after the write lands, keeps the draft when the editor remounts, and refuses to
// save a truncated file. Driven through the real invoke seam (mockIPC), no module mocking.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { draftDrop, draftFor } from "./drafts";
import { useFileDoc } from "./useFileDoc";
import { FileConflictNotice } from "../../ui/FileConflictNotice";

// SAFETY: React's test-only flag enables act warnings for this DOM fixture.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type DocProps = { project: string; scope: string | null; path: string; onDirty?: (d: boolean) => void; onSaved?: () => void };

function DocHarness({ project, scope, path, onDirty, onSaved }: DocProps) {
  const doc = useFileDoc(project, scope, path, onDirty, onSaved);
  return (
    <div>
      <span data-load={doc.load.kind} />
      <span data-draft={doc.draft} />
      <span data-dirty={String(doc.dirty)} />
      <span data-error={doc.saveError ?? ""} />
      <span data-conflict={doc.conflict?.text ?? ""} />
      <span data-saving={String(doc.saving)} />
      <button type="button" onClick={doc.keepMine}>keep</button>
      <button type="button" onClick={doc.loadTheirs}>load</button>
      <button type="button" onClick={() => doc.edit(doc.draft + "x")}>type</button>
      <button type="button" onClick={doc.save}>save</button>
      {doc.conflict && <FileConflictNotice mine={doc.draft} theirs={doc.conflict.text} truncated={doc.conflict.truncated} onKeepMine={doc.keepMine} onLoadTheirs={doc.loadTheirs} />}
    </div>
  );
}

type WriteCall = { command: string; args: { project: string; path: string; seat: string | null; text: string; expectedText?: string } };
let writes: WriteCall[] = [];
let failWrites: string | null = null;
let disk: string;
let failReads: string | null;
let commands: { command: string; project?: string }[];
let pendingWrite: Promise<void> | null;
let pendingRead: Promise<string> | null;
let changeBeforeWrite: string | null;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  writes = [];
  failWrites = null;
  disk = "hello";
  failReads = null;
  commands = [];
  pendingWrite = null;
  pendingRead = null;
  changeBeforeWrite = null;
  mockIPC(async (command, args) => {
    // SAFETY: mockIPC types args as unknown; the file commands are invoked with an object of named args.
    const named = (args ?? {}) as { project?: string; path?: string; seat?: string | null; text?: string; expectedText?: string; truncated?: boolean };
    commands.push({ command, project: named.project });
    if (command === "read_file") {
      if (failReads) throw new Error(failReads);
      if (pendingRead) { const read = pendingRead; pendingRead = null; return read; }
      const truncated = named.path === "big.bin";
      return JSON.stringify({ text: disk, truncated, bytes: disk.length });
    }
    if (command === "file_write_plain") {
      if (changeBeforeWrite !== null) disk = changeBeforeWrite;
      if (named.expectedText !== undefined && named.expectedText !== disk) throw new Error("file_changed_on_disk");
      if (failWrites) throw new Error(failWrites);
      writes.push({ command, args: { project: named.project ?? "", path: named.path ?? "", seat: named.seat ?? null, text: named.text ?? "", expectedText: named.expectedText } });
      await pendingWrite;
      disk = named.text ?? "";
      return null;
    }
    return null;
  }, { shouldMockEvents: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
// Real timers first: a fake-timer test below must not leave the flush's setTimeout hanging.
afterEach(async () => { vi.useRealTimers(); await act(async () => root.unmount()); await flush(); host.remove(); clearMocks(); draftDrop("trantor", null, "src/a.ts"); draftDrop("trantor", "glm-5", "src/a.ts"); });

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });
const mount = async (props: DocProps) => { await act(async () => { root.render(<DocHarness {...props} />); }); await flush(); };
const click = async (text: string) => { await act(async () => { [...host.querySelectorAll("button")].find(b => b.textContent === text)?.click(); }); await flush(); };
const changed = async (project = "trantor", paths = ["src/a.ts"]) => {
  await act(async () => { await emit("file-changed", { project, paths }); });
  await flush();
};
const attr = (name: string) => host.querySelector(`[data-${name}]`)?.getAttribute(`data-${name}`) ?? "";

describe("useFileDoc", () => {
  it("loads clean, reports dirty on edit, saves plainly and reports clean and saved after the write", async () => {
    const onDirty = vi.fn();
    const onSaved = vi.fn();
    await mount({ project: "trantor", scope: null, path: "src/a.ts", onDirty, onSaved });
    expect(attr("load")).toBe("ok");
    expect(attr("draft")).toBe("hello");
    expect(attr("dirty")).toBe("false");
    expect(onDirty).toHaveBeenLastCalledWith(false);
    await click("type");
    expect(attr("draft")).toBe("hellox");
    expect(onDirty).toHaveBeenLastCalledWith(true);
    await click("save");
    expect(writes).toEqual([{ command: "file_write_plain", args: { project: "trantor", path: "src/a.ts", seat: null, text: "hellox", expectedText: "hello" } }]);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onDirty).toHaveBeenLastCalledWith(false);
    expect(attr("dirty")).toBe("false");
    expect(attr("error")).toBe("");
  });

  it("sends the seat with every read and write when the tab is scoped to a seat", async () => {
    await mount({ project: "trantor", scope: "glm-5", path: "src/a.ts" });
    await click("type");
    await click("save");
    expect(writes[0]?.args.seat).toBe("glm-5");
  });

  it("a refused save keeps the draft dirty and says why, without reporting saved", async () => {
    const onDirty = vi.fn();
    const onSaved = vi.fn();
    await mount({ project: "trantor", scope: "glm-5", path: "src/a.ts", onDirty, onSaved });
    await click("type");
    failWrites = "glm-5 is working in this worktree right now — edit it once the seat lands";
    await click("save");
    expect(attr("error")).toContain("glm-5 is working");
    expect(attr("dirty")).toBe("true");
    expect(onSaved).not.toHaveBeenCalled();
    expect(onDirty).toHaveBeenLastCalledWith(true);
  });

  it("a remount resumes the unsaved draft, still dirty", async () => {
    const onDirty = vi.fn();
    await mount({ project: "trantor", scope: null, path: "src/a.ts", onDirty });
    await click("type");
    await click("type");
    expect(draftFor("trantor", null, "src/a.ts")).toBe("helloxx");
    act(() => root.unmount());
    host.remove();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const onDirty2 = vi.fn();
    await mount({ project: "trantor", scope: null, path: "src/a.ts", onDirty: onDirty2 });
    expect(attr("draft")).toBe("helloxx");
    expect(attr("dirty")).toBe("true");
    expect(onDirty2).toHaveBeenLastCalledWith(true);
  });

  it("never writes a truncated file, even if a draft somehow differs from the disk text", async () => {
    await mount({ project: "trantor", scope: null, path: "big.bin" });
    expect(attr("load")).toBe("ok");
    await click("type");
    await click("save");
    expect(writes).toEqual([]);
  });

  it("a clean document has nothing to save", async () => {
    const onSaved = vi.fn();
    await mount({ project: "trantor", scope: null, path: "src/a.ts", onSaved });
    await click("save");
    expect(writes).toEqual([]);
    expect(onSaved).not.toHaveBeenCalled();
  });
  // The cache holds unsaved text only: a draft equal to the disk would later hide a change an agent made.
  it("drops the cached draft once the text is saved", async () => {
    await mount({ project: "trantor", scope: null, path: "src/a.ts" });
    await click("type");
    expect(draftFor("trantor", null, "src/a.ts")).toBe("hellox");
    await click("save");
    expect(attr("dirty")).toBe("false");
    expect(draftFor("trantor", null, "src/a.ts")).toBeNull();
  });
});


describe("external file changes (#14486)", () => {
  it("offers a calm notice and a comparison that leaves both copies untouched", async () => {
    await mount({ project: "trantor", scope: null, path: "src/a.ts" });
    await click("type");
    disk = "agent edit";
    await changed();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("changed on disk");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await click("Compare");
    expect([...host.querySelectorAll("pre")].map(pre => pre.textContent)).toEqual(["agent edit", "hellox"]);
    expect(writes).toHaveLength(0);
    expect(disk).toBe("agent edit");
    await click("Hide comparison");
    expect(host.querySelector("pre")).toBeNull();
    await click("Load theirs");
    expect(attr("draft")).toBe("agent edit");
    expect(host.querySelector('[data-note="file-changed-on-disk"]')).toBeNull();
  });
  it("silently reloads a clean file and ignores another project or path", async () => {
    await mount({ project: "trantor", scope: null, path: "src/a.ts" });
    disk = "agent edit";
    await changed("another");
    await changed("trantor", ["src/b.ts"]);
    expect(attr("draft")).toBe("hello");
    await changed();
    expect(attr("draft")).toBe("agent edit");
    expect(attr("dirty")).toBe("false");
    expect(attr("conflict")).toBe("");
  });

  it("keeps a dirty draft and refuses save until the conflict is resolved", async () => {
    const onSaved = vi.fn();
    await mount({ project: "trantor", scope: null, path: "src/a.ts", onSaved });
    await click("type");
    disk = "agent edit";
    await changed();
    expect(attr("draft")).toBe("hellox");
    expect(attr("conflict")).toBe("agent edit");
    await click("save");
    expect(writes).toHaveLength(0);
    expect(onSaved).not.toHaveBeenCalled();
    await click("load");
    expect(attr("draft")).toBe("agent edit");
    expect(attr("dirty")).toBe("false");
    expect(draftFor("trantor", null, "src/a.ts")).toBeNull();
  });

  it("rechecks disk before saving even without a watcher event", async () => {
    await mount({ project: "trantor", scope: null, path: "src/a.ts" });
    await click("type");
    disk = "unannounced edit";
    await click("save");
    expect(writes).toHaveLength(0);
    expect(disk).toBe("unannounced edit");
    expect(attr("conflict")).toBe("unannounced edit");
    expect(attr("saving")).toBe("false");
  });

  it("turns a write-side baseline mismatch into the conflict notice", async () => {
    const onSaved = vi.fn();
    await mount({ project: "trantor", scope: null, path: "src/a.ts", onSaved });
    await click("type");
    changeBeforeWrite = "edit after preflight";
    await click("save");
    expect(writes).toHaveLength(0);
    expect(disk).toBe("edit after preflight");
    expect(attr("conflict")).toBe("edit after preflight");
    expect(attr("draft")).toBe("hellox");
    expect(attr("error")).toBe("");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("reloads seat files only for events from that seat", async () => {
    await mount({ project: "trantor", scope: "glm-5", path: "src/a.ts" });
    disk = "seat edit";
    await changed();
    expect(attr("draft")).toBe("hello");
    await act(async () => { await emit("file-changed", { project: "trantor", seat: "glm-5", paths: ["src/a.ts"] }); });
    await flush();
    expect(attr("draft")).toBe("seat edit");
  });

  it("Keep mine adopts only the shown disk copy and checks for another change on save", async () => {
    await mount({ project: "trantor", scope: null, path: "src/a.ts" });
    await click("type");
    disk = "first agent edit";
    await changed();
    await click("keep");
    expect(writes).toHaveLength(0);
    expect(attr("draft")).toBe("hellox");
    expect(attr("conflict")).toBe("");
    disk = "second agent edit";
    await click("save");
    expect(writes).toHaveLength(0);
    expect(attr("conflict")).toBe("second agent edit");
    await click("keep");
    await click("save");
    expect(disk).toBe("hellox");
    expect(writes).toHaveLength(1);
  });

  it("retains the baseline across a tab switch and detects changes while inactive", async () => {
    await mount({ project: "trantor", scope: null, path: "src/a.ts" });
    await click("type");
    await mount({ project: "trantor", scope: null, path: "src/b.ts" });
    disk = "changed while away";
    await mount({ project: "trantor", scope: null, path: "src/a.ts" });
    expect(attr("draft")).toBe("hellox");
    expect(attr("conflict")).toBe("changed while away");
    await click("save");
    expect(writes).toHaveLength(0);
  });

  it("releases the watcher on project switch and final unmount", async () => {
    await mount({ project: "trantor", scope: null, path: "src/a.ts" });
    await mount({ project: "other", scope: null, path: "src/a.ts" });
    await act(async () => root.unmount());
    await flush();
    expect(commands.filter(c => c.command === "file_watch").map(c => c.project)).toEqual(["trantor", "other"]);
    expect(commands.filter(c => c.command === "file_unwatch").map(c => c.project)).toEqual(["trantor", "other"]);
    const reads = commands.filter(c => c.command === "read_file").length;
    await changed();
    expect(commands.filter(c => c.command === "read_file")).toHaveLength(reads);
  });

  it("never saves when reading the current disk copy fails", async () => {
    await mount({ project: "trantor", scope: null, path: "src/a.ts" });
    await click("type");
    failReads = "file no longer exists";
    await click("save");
    expect(writes).toHaveLength(0);
    expect(attr("error")).toBe("file no longer exists");
    expect(attr("draft")).toBe("hellox");
    expect(attr("saving")).toBe("false");
  });

  it("refuses a file that grew past the preview limit even when its prefix matches", async () => {
    await mount({ project: "trantor", scope: null, path: "src/a.ts" });
    await click("type");
    pendingRead = Promise.resolve(JSON.stringify({ text: "hello", truncated: true, bytes: 600000 }));
    await click("save");
    expect(writes).toHaveLength(0);
    expect(attr("conflict")).toBe("hello");
    expect(host.querySelector('[role="status"]')?.textContent).toContain("truncated");
    await click("keep");
    await click("save");
    expect(writes).toHaveLength(0);
  });

  it("keeps edits made during a save dirty and prevents duplicate writes", async () => {
    await mount({ project: "trantor", scope: null, path: "src/a.ts" });
    await click("type");
    let complete = () => {};
    pendingWrite = new Promise<void>(resolve => { complete = resolve; });
    await click("save");
    await click("type");
    await click("save");
    expect(writes).toHaveLength(1);
    await act(async () => { complete(); });
    await flush();
    expect(disk).toBe("hellox");
    expect(attr("draft")).toBe("helloxx");
    expect(attr("dirty")).toBe("true");
    expect(draftFor("trantor", null, "src/a.ts")).toBe("helloxx");
  });

  it("ignores a late read from the previous file", async () => {
    await mount({ project: "trantor", scope: null, path: "src/a.ts" });
    let complete = (_value: string) => {};
    pendingRead = new Promise<string>(resolve => { complete = resolve; });
    await changed();
    disk = "new file";
    await mount({ project: "trantor", scope: null, path: "src/b.ts" });
    await act(async () => { complete(JSON.stringify({ text: "old file", truncated: false, bytes: 8 })); });
    await flush();
    expect(attr("draft")).toBe("new file");
  });

  it("treats an external save of the same draft as clean", async () => {
    await mount({ project: "trantor", scope: null, path: "src/a.ts" });
    await click("type");
    disk = "hellox";
    await changed();
    expect(attr("dirty")).toBe("false");
    expect(attr("conflict")).toBe("");
    expect(draftFor("trantor", null, "src/a.ts")).toBeNull();
  });
});

// #14488: the draft rides to disk — debounced draft_persist while typing (the baseline rides
// along as a companion so a restart can check the draft against the disk), resume from the copy
// the last exit persisted, and a save that holds the write-behind then retires it with
// draft_forget.
describe("useFileDoc drafts on disk", () => {
  type Named = { project?: string; path?: string; seat?: string | null; text?: string };
  const settle = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  // Fake timers make the shared flush helper's setTimeout hang, so these render and click their own way.
  const renderDoc = async (props: DocProps) => { await act(async () => { root.render(<DocHarness {...props} />); }); await settle(); };
  const clickDoc = async (label: string) => {
    await act(async () => { [...host.querySelectorAll("button")].find(b => b.textContent === label)?.click(); });
    await settle();
  };

  it("persists the draft and its baseline as they are typed, debounced, and flushes the pending writes on unmount", async () => {
    vi.useFakeTimers();
    const persist: Named[] = [];
    mockIPC((command, args) => {
      // SAFETY: mockIPC types args as unknown; the file commands are invoked with an object of named args.
      const named = (args ?? {}) as Named;
      if (command === "read_file") return JSON.stringify({ text: "hello", truncated: false, bytes: 5 });
      if (command === "draft_persist") { persist.push(named); return null; }
      return null;
    });
    await renderDoc({ project: "trantor", scope: null, path: "src/a.ts" });
    await clickDoc("type");
    await advance(599);
    expect(persist).toEqual([]);
    await advance(1);
    expect(persist).toEqual([
      { project: "trantor", path: "src/a.ts", seat: null, text: "hellox" },
      { project: "trantor", path: "src/a.ts\u0000baseline", seat: null, text: "\"hello\"" },
    ]);
    await clickDoc("type");
    await act(async () => { root.unmount(); });
    expect(persist.slice(-2)).toEqual([
      { project: "trantor", path: "src/a.ts", seat: null, text: "helloxx" },
      { project: "trantor", path: "src/a.ts\u0000baseline", seat: null, text: "\"hello\"" },
    ]);
  });

  it("resumes the draft the last exit persisted, still dirty, with the disk unchanged", async () => {
    mockIPC((command, args) => {
      // SAFETY: mockIPC types args as unknown; the file commands are invoked with an object of named args.
      const named = (args ?? {}) as Named;
      if (command === "read_file") return JSON.stringify({ text: "hello", truncated: false, bytes: 5 });
      if (command === "draft_load" && named.path === "src/a.ts") return "persisted words";
      if (command === "draft_load" && named.path === "src/a.ts\u0000baseline") return JSON.stringify("hello");
      return null;
    });
    await mount({ project: "trantor", scope: null, path: "src/a.ts" });
    expect(attr("draft")).toBe("persisted words");
    expect(attr("dirty")).toBe("true");
    expect(attr("conflict")).toBe("");
  });

  // The merged rule: a restored draft is checked against the disk baseline, so a file an agent
  // rewrote while the app was closed shows the notice — the draft never silently wins.
  it("a restart whose file changed on disk shows the conflict notice and refuses the save", async () => {
    const wrote: string[] = [];
    mockIPC((command, args) => {
      // SAFETY: mockIPC types args as unknown; the file commands are invoked with an object of named args.
      const named = (args ?? {}) as Named;
      if (command === "read_file") return JSON.stringify({ text: "agent wrote while the app was closed", truncated: false, bytes: 5 });
      if (command === "draft_load" && named.path === "src/a.ts") return "persisted words";
      if (command === "draft_load" && named.path === "src/a.ts\u0000baseline") return JSON.stringify("hello");
      if (command === "file_write_plain") { wrote.push(named.path ?? ""); return null; }
      return null;
    });
    await mount({ project: "trantor", scope: null, path: "src/a.ts" });
    expect(attr("draft")).toBe("persisted words");
    expect(attr("conflict")).toBe("agent wrote while the app was closed");
    expect(host.querySelector('[role="status"]')?.textContent).toContain("changed on disk");
    await click("save");
    expect(wrote).toEqual([]);
  });

  it("a save holds the write-behind and retires the draft and its baseline with draft_forget once the write lands", async () => {
    vi.useFakeTimers();
    const persist: Named[] = [];
    const forget: Named[] = [];
    mockIPC((command, args) => {
      // SAFETY: mockIPC types args as unknown; the file commands are invoked with an object of named args.
      const named = (args ?? {}) as Named;
      if (command === "read_file") return JSON.stringify({ text: "hello", truncated: false, bytes: 5 });
      if (command === "file_write_plain") { writes.push({ command, args: { project: named.project ?? "", path: named.path ?? "", seat: named.seat ?? null, text: named.text ?? "" } }); return null; }
      if (command === "draft_persist") { persist.push(named); return null; }
      if (command === "draft_forget") { forget.push(named); return null; }
      return null;
    });
    await renderDoc({ project: "trantor", scope: null, path: "src/a.ts" });
    await clickDoc("type");
    await advance(300);
    // A clean load retires any ghost twice (the open read and the watcher's first refresh); the
    // assertion below is about what the SAVE retires, so start its count here.
    forget.length = 0;
    await clickDoc("save");
    await advance(600);
    expect(persist).toEqual([]);
    expect(forget).toEqual([
      { project: "trantor", path: "src/a.ts", seat: null },
      { project: "trantor", path: "src/a.ts\u0000baseline", seat: null },
    ]);
  });
});

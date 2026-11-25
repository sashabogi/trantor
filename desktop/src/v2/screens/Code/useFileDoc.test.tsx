// @vitest-environment happy-dom
// #14072: the file document reports clean and dirty for the tab's dot, saves plainly and calls
// onSaved only after the write lands, keeps the draft when the editor remounts, and refuses to
// save a truncated file. Driven through the real invoke seam (mockIPC), no module mocking.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { draftDrop, draftFor } from "./drafts";
import { useFileDoc } from "./useFileDoc";

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
      <button type="button" onClick={() => doc.edit(doc.draft + "x")}>type</button>
      <button type="button" onClick={doc.save}>save</button>
    </div>
  );
}

type WriteCall = { command: string; args: { project: string; path: string; seat: string | null; text: string } };
let writes: WriteCall[] = [];
let failWrites: string | null = null;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  writes = [];
  failWrites = null;
  mockIPC((command, args) => {
    // SAFETY: mockIPC types args as unknown; the file commands are invoked with an object of named args.
    const named = (args ?? {}) as { project?: string; path?: string; seat?: string | null; text?: string; truncated?: boolean };
    if (command === "read_file") {
      const truncated = named.path === "big.bin";
      return JSON.stringify({ text: "hello", truncated, bytes: 5 });
    }
    if (command === "file_write_plain") {
      if (failWrites) throw new Error(failWrites);
      writes.push({ command, args: { project: named.project ?? "", path: named.path ?? "", seat: named.seat ?? null, text: named.text ?? "" } });
      return null;
    }
    return null;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearMocks(); draftDrop("trantor", null, "src/a.ts"); draftDrop("trantor", "glm-5", "src/a.ts"); });

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });
const mount = async (props: DocProps) => { await act(async () => { root.render(<DocHarness {...props} />); }); await flush(); };
const click = async (text: string) => { await act(async () => { [...host.querySelectorAll("button")].find(b => b.textContent === text)?.click(); }); await flush(); };
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
    expect(writes).toEqual([{ command: "file_write_plain", args: { project: "trantor", path: "src/a.ts", seat: null, text: "hellox" } }]);
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

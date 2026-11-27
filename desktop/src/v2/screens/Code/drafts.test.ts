// @vitest-environment happy-dom
// #14072: the memory slots, keyed like a tab. #14488: the draft rides to disk through the classic
// draft_persist/load/forget commands — debounced, cancellable, restorable, its baseline riding
// along as a companion. Fakes sit only at the Tauri IPC boundary; fake timers drive the debounce.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { draftBaseline, draftDrop, draftFlush, draftFor, draftKeep, draftHold, draftResume } from "./drafts";

type Args = { project?: string; path?: string; seat?: string | null; text?: string };
let persist: Args[];
let forget: Args[];
let disk: Map<string, string>;

beforeEach(() => {
  vi.useFakeTimers();
  persist = []; forget = []; disk = new Map();
  mockIPC((cmd, args) => {
    // SAFETY: mockIPC types args as unknown; the draft commands are invoked with an object of named args.
    const named = (args ?? {}) as Args;
    // The Rust side keys a draft by project, seat and path; the mock mirrors that triple.
    const at = `${named.project ?? ""}:${named.seat ?? ""}:${named.path}`;
    if (cmd === "draft_persist") { persist.push(named); disk.set(at, named.text ?? ""); return null; }
    if (cmd === "draft_forget") { forget.push(named); disk.delete(at); return null; }
    if (cmd === "draft_load") return disk.get(at) ?? "";
    return null;
  });
});
afterEach(() => { clearMocks(); vi.useRealTimers(); });

describe("drafts memory slots (#14072)", () => {
  it("keeps an unsaved draft per project, scope and path", () => {
    draftKeep("p1", null, "src/a.ts", "one");
    draftKeep("p1", "glm-5", "src/a.ts", "two");
    expect(draftFor("p1", null, "src/a.ts")).toBe("one");
    expect(draftFor("p1", "glm-5", "src/a.ts")).toBe("two");
    expect(draftFor("p1", null, "src/b.ts")).toBeNull();
    expect(draftFor("p2", null, "src/a.ts")).toBeNull();
  });

  it("dropping the draft leaves nothing to resume, and dropping again is fine", () => {
    draftKeep("p3", null, "src/c.ts", "kept");
    draftDrop("p3", null, "src/c.ts");
    expect(draftFor("p3", null, "src/c.ts")).toBeNull();
    draftDrop("p3", null, "src/c.ts");
    expect(draftFor("p3", null, "src/c.ts")).toBeNull();
  });
});

describe("drafts on disk (#14488)", () => {
  it("persists a kept draft after the debounce, once, with the scope as the seat", async () => {
    draftKeep("trantor", null, "src/a.ts", "one");
    await vi.advanceTimersByTimeAsync(599);
    expect(persist).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toEqual([{ project: "trantor", path: "src/a.ts", seat: null, text: "one" }]);
    // A second keep of the same draft resets the timer; only the last text is ever written.
    draftKeep("trantor", "glm-5", "src/a.ts", "two");
    await vi.advanceTimersByTimeAsync(300);
    draftKeep("trantor", "glm-5", "src/a.ts", "three");
    await vi.advanceTimersByTimeAsync(300);
    expect(persist).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(persist).toEqual([
      { project: "trantor", path: "src/a.ts", seat: null, text: "one" },
      { project: "trantor", path: "src/a.ts", seat: "glm-5", text: "three" },
    ]);
  });

  it("a drop cancels the pending write and retires the persisted copy and its baseline", async () => {
    draftKeep("trantor", null, "src/a.ts", "typed back", "hello");
    draftDrop("trantor", null, "src/a.ts");
    await vi.advanceTimersByTimeAsync(600);
    expect(persist).toEqual([]);
    expect(forget).toEqual([
      { project: "trantor", path: "src/a.ts", seat: null },
      { project: "trantor", path: "src/a.ts\u0000baseline", seat: null },
    ]);
  });

  // The baseline companion: a restart needs the disk text the draft was kept against, or a file
  // that changed while the app was closed could not raise the conflict notice (#14486's rule).
  it("persists the baseline alongside the draft, JSON-wrapped so an empty disk survives", async () => {
    draftKeep("trantor", null, "src/a.ts", "hellox", "hello");
    draftKeep("trantor", null, "src/empty.ts", "first words", "");
    await vi.advanceTimersByTimeAsync(600);
    expect(persist).toEqual([
      { project: "trantor", path: "src/a.ts", seat: null, text: "hellox" },
      { project: "trantor", path: "src/a.ts\u0000baseline", seat: null, text: "\"hello\"" },
      { project: "trantor", path: "src/empty.ts", seat: null, text: "first words" },
      { project: "trantor", path: "src/empty.ts\u0000baseline", seat: null, text: "\"\"" },
    ]);
  });

  it("a restart's resume carries the persisted baseline into the slot, empty included", async () => {
    disk.set("trantor::src/a.ts", "hellox");
    disk.set("trantor::src/a.ts\u0000baseline", JSON.stringify("hello"));
    disk.set("trantor::src/empty.ts", "first words");
    disk.set("trantor::src/empty.ts\u0000baseline", JSON.stringify(""));
    await expect(draftResume("trantor", null, "src/a.ts")).resolves.toBe("hellox");
    expect(draftBaseline("trantor", null, "src/a.ts")).toBe("hello");
    await expect(draftResume("trantor", null, "src/empty.ts")).resolves.toBe("first words");
    expect(draftBaseline("trantor", null, "src/empty.ts")).toBe("");
  });

  it("a draft the classic lens persisted has no companion, so the baseline stays unknown", async () => {
    disk.set("trantor::src/classic.ts", "classic words");
    await expect(draftResume("trantor", null, "src/classic.ts")).resolves.toBe("classic words");
    expect(draftBaseline("trantor", null, "src/classic.ts")).toBeUndefined();
  });

  it("a hold only cancels the write-behind: the memory draft stays for a remount", async () => {
    draftKeep("trantor", null, "src/a.ts", "saving");
    draftHold("trantor", null, "src/a.ts");
    await vi.advanceTimersByTimeAsync(600);
    expect(persist).toEqual([]);
    expect(draftFor("trantor", null, "src/a.ts")).toBe("saving");
  });

  it("a flush fires the pending write now instead of waiting out the window", async () => {
    draftKeep("trantor", null, "src/a.ts", "last words");
    draftFlush("trantor", null, "src/a.ts");
    expect(persist).toEqual([{ project: "trantor", path: "src/a.ts", seat: null, text: "last words" }]);
    await vi.advanceTimersByTimeAsync(600);
    expect(persist).toHaveLength(1);
  });

  it("resumes from the memory slot first, then the disk copy a restart left, and owns it once read", async () => {
    draftKeep("trantor", null, "src/kept.ts", "in memory");
    disk.set("trantor::src/disk.ts", "from the last exit");
    await expect(draftResume("trantor", null, "src/kept.ts")).resolves.toBe("in memory");
    await expect(draftResume("trantor", null, "src/disk.ts")).resolves.toBe("from the last exit");
    // The disk hit now owns the memory slot: a tab switch resumes without a second read.
    expect(draftFor("trantor", null, "src/disk.ts")).toBe("from the last exit");
    await expect(draftResume("other", null, "src/disk.ts")).resolves.toBeNull();
    await expect(draftResume("trantor", "glm-5", "src/disk.ts")).resolves.toBeNull();
  });
});

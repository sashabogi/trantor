// @vitest-environment happy-dom
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchFiles } from "./fileWatch";

let calls: { command: string; project?: string }[];
let stop: (() => void)[];
let pendingWatch: Promise<void> | null;
let watchError: string | null;
const flush = () => new Promise(resolve => setTimeout(resolve, 10));

beforeEach(() => {
  calls = [];
  stop = [];
  pendingWatch = null;
  watchError = null;
  mockIPC(async (command, args) => {
    // SAFETY: these Tauri commands carry named project arguments.
    const named = (args ?? {}) as { project?: string };
    calls.push({ command, project: named.project });
    if (command === "file_watch") {
      if (watchError) throw new Error(watchError);
      await pendingWatch;
    }
    return null;
  }, { shouldMockEvents: true });
});
afterEach(async () => { for (const release of stop) release(); await flush(); clearMocks(); });

const subscribe = (project: string, changed = vi.fn(), failed = vi.fn()) => {
  const release = watchFiles(project, null, changed, failed);
  stop.push(release);
  return { release, changed, failed };
};

describe("file watcher ownership", () => {
  it("shares a project watcher and stops only when its last editor leaves", async () => {
    const a = subscribe("p");
    const b = subscribe("p");
    await flush();
    expect(calls.filter(c => c.command === "file_watch")).toHaveLength(1);
    await emit("file-changed", { project: "p", paths: ["a.ts"] });
    expect(a.changed).toHaveBeenLastCalledWith(["a.ts"]);
    expect(b.changed).toHaveBeenLastCalledWith(["a.ts"]);
    a.release();
    await flush();
    expect(calls.filter(c => c.command === "file_unwatch")).toHaveLength(0);
    b.release();
    await flush();
    expect(calls.filter(c => c.command === "file_unwatch")).toHaveLength(1);
    b.changed.mockClear();
    await emit("file-changed", { project: "p", paths: ["a.ts"] });
    expect(b.changed).not.toHaveBeenCalled();
  });

  it("finishes an in-flight start before stopping and restarting that project", async () => {
    let complete = () => {};
    pendingWatch = new Promise<void>(resolve => { complete = resolve; });
    const first = subscribe("p");
    await flush();
    first.release();
    const second = subscribe("p");
    expect(calls.map(c => c.command)).toEqual(["file_watch"]);
    complete();
    await flush();
    expect(calls.map(c => c.command)).toEqual(["file_watch", "file_unwatch", "file_watch"]);
    await emit("file-changed", { project: "p", paths: ["a.ts"] });
    expect(first.changed).not.toHaveBeenCalled();
    expect(second.changed).toHaveBeenLastCalledWith(["a.ts"]);
  });

  it("routes events to their project and reports startup failures", async () => {
    const a = subscribe("p");
    await flush();
    a.changed.mockClear();
    await emit("file-changed", { project: "other", paths: ["a.ts"] });
    expect(a.changed).not.toHaveBeenCalled();
    watchError = "watch unavailable";
    const failed = subscribe("missing");
    await flush();
    expect(failed.failed).toHaveBeenCalledWith("watch unavailable");
  });
});

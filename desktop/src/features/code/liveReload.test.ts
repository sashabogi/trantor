// The reload-vs-conflict rule is the live viewer's one non-negotiable: a reload may never clobber
// unsaved edits, and a clean editor should follow the disk without a prompt. Pinned here so the
// rule outlives whichever component wires it in.
import { describe, expect, it } from "vitest";
import { decideReload, type FileStat } from "./liveReload";

const stat = (mtimeMs: number, bytes = 100): FileStat => ({ mtimeMs, bytes });

describe("decideReload", () => {
  it("does nothing when there is no fresh stat to compare", () => {
    expect(decideReload({ dirty: false, lastStat: stat(1), newStat: null })).toBe("none");
  });

  it("does nothing before the first poll establishes a baseline", () => {
    expect(decideReload({ dirty: false, lastStat: null, newStat: stat(1) })).toBe("none");
  });

  it("does nothing when the stat is unchanged", () => {
    expect(decideReload({ dirty: false, lastStat: stat(1), newStat: stat(1) })).toBe("none");
  });

  it("reloads silently when the file changed and the editor is clean", () => {
    expect(decideReload({ dirty: false, lastStat: stat(1), newStat: stat(2) })).toBe("reload");
  });

  it("treats a size change without an mtime change as changed", () => {
    expect(decideReload({ dirty: false, lastStat: stat(1, 100), newStat: stat(1, 200) })).toBe("reload");
  });

  it("flags a conflict instead of reloading when the editor is dirty", () => {
    expect(decideReload({ dirty: true, lastStat: stat(1), newStat: stat(2) })).toBe("conflict");
  });

  it("flags a conflict when dirty even if the stat otherwise matches", () => {
    // Dirty with no change on disk is "none": there is nothing on disk to conflict with.
    expect(decideReload({ dirty: true, lastStat: stat(1), newStat: stat(1) })).toBe("none");
  });
});

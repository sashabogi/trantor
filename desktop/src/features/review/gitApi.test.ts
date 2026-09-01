// The git panel's TS-side logic is exactly two pure functions — porcelain bucketing and the
// position label — so they carry the panel's whole test weight here. The Rust side owns the git
// subprocesses; these tests pin the contract the panel renders against.
import { describe, expect, it } from "vitest";
import { aheadLabel, bucketStatus } from "./gitApi";

describe("bucketStatus", () => {
  it("splits staged, unstaged, and untracked from raw porcelain rows", () => {
    const { staged, unstaged, untracked } = bucketStatus([
      { path: "staged-only.ts", x: "M", y: " " },
      { path: "unstaged-only.ts", x: " ", y: "M" },
      { path: "both.ts", x: "M", y: "M" },
      { path: "brand-new.ts", x: "?", y: "?" },
      { path: "staged-new.ts", x: "A", y: " " },
      { path: "gone.ts", x: " ", y: "D" },
    ]);
    expect(staged.map(e => e.path)).toEqual(["staged-only.ts", "both.ts", "staged-new.ts"]);
    expect(unstaged.map(e => e.path)).toEqual(["unstaged-only.ts", "both.ts", "gone.ts"]);
    expect(untracked).toEqual(["brand-new.ts"]);
  });

  it("keeps the raw XY codes on entries so the UI can title them", () => {
    const { staged } = bucketStatus([{ path: "a.ts", x: "R", y: " " }]);
    expect(staged[0]).toEqual({ path: "a.ts", x: "R", y: " " });
  });

  it("shows a staged-then-edited file in BOTH lists rather than picking one", () => {
    const { staged, unstaged } = bucketStatus([{ path: "both.ts", x: "M", y: "M" }]);
    expect(staged.map(e => e.path)).toEqual(["both.ts"]);
    expect(unstaged.map(e => e.path)).toEqual(["both.ts"]);
  });

  it("returns empty buckets for a clean worktree", () => {
    expect(bucketStatus([])).toEqual({ staged: [], unstaged: [], untracked: [] });
  });
});

describe("aheadLabel", () => {
  it("renders both arrows against an upstream", () => {
    expect(aheadLabel({ ahead: 3, behind: 1, upstream: "origin/seat/glm" })).toBe("↑3 ↓1");
  });

  it("drops the zero side of the arrows", () => {
    expect(aheadLabel({ ahead: 2, behind: 0, upstream: "origin/main" })).toBe("↑2");
    expect(aheadLabel({ ahead: 0, behind: 4, upstream: "origin/main" })).toBe("↓4");
  });

  it("says in sync when the upstream matches", () => {
    expect(aheadLabel({ ahead: 0, behind: 0, upstream: "origin/main" })).toBe("in sync");
  });

  it("without an upstream, ahead means unlanded work and behind is never claimed", () => {
    expect(aheadLabel({ ahead: 5, behind: null, upstream: null })).toBe("5 unlanded");
    expect(aheadLabel({ ahead: 0, behind: null, upstream: null })).toBe("all landed");
  });
});

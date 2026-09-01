// The git panel's TS-side logic is exactly two pure functions — porcelain bucketing and the
// position label — so they carry the panel's whole test weight here. The Rust side owns the git
// subprocesses; these tests pin the contract the panel renders against.
import { describe, expect, it } from "vitest";
import { aheadLabel, bucketStatus, isUnmerged, lineCountFor, scmSections, stageableChanges } from "./gitApi";

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
    expect(staged[0]).toEqual({ path: "a.ts", x: "R", y: " " });;
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

describe("scmSections", () => {
  it("splits staged from changes, and merges unstaged with untracked", () => {
    const { staged, changes } = scmSections([
      { path: "staged-only.ts", x: "M", y: " " },
      { path: "unstaged-only.ts", x: " ", y: "M" },
      { path: "brand-new.ts", x: "?", y: "?" },
      { path: "gone.ts", x: " ", y: "D" },
    ]);
    expect(staged).toEqual(["staged-only.ts"]);
    expect(changes).toEqual(["unstaged-only.ts", "gone.ts", "brand-new.ts"]);
  });

  it("keeps a staged-then-edited path in BOTH sections, the bulk actions' pathspecs", () => {
    const { staged, changes } = scmSections([{ path: "both.ts", x: "M", y: "M" }]);
    expect(staged).toEqual(["both.ts"]);
    expect(changes).toEqual(["both.ts"]);
  });

  it("returns empty sections for a clean worktree", () => {
    expect(scmSections([])).toEqual({ staged: [], changes: [] });
  });
});

describe("conflict protection (#5811)", () => {
  it("reads unmerged straight off the porcelain XY codes", () => {
    expect(isUnmerged({ x: "U", y: "U" })).toBe(true);
    expect(isUnmerged({ x: "A", y: "A" })).toBe(true);
    expect(isUnmerged({ x: "D", y: "D" })).toBe(true);
    expect(isUnmerged({ x: "U", y: "A" })).toBe(true);
    expect(isUnmerged({ x: "M", y: " " })).toBe(false);
    expect(isUnmerged({ x: "?", y: "?" })).toBe(false);
  });

  it("stageableChanges excludes conflicted rows from the bulk-stage batch", () => {
    expect(stageableChanges([
      { path: "clean-edit.ts", x: " ", y: "M" },
      { path: "war.ts", x: "U", y: "U" },
      { path: "fresh.ts", x: "?", y: "?" },
    ])).toEqual(["clean-edit.ts", "fresh.ts"]);
    expect(stageableChanges([{ path: "war.ts", x: "U", y: "U" }])).toEqual([]);
  });
});

describe("lineCountFor (#5811)", () => {
  const counts = [
    { path: "a.ts", plus: 12, minus: 3 },
    { path: "b.ts", plus: 0, minus: 7 },
  ];

  it("returns the counted values for a changed path", () => {
    expect(lineCountFor(counts, "a.ts")).toEqual({ plus: 12, minus: 3 });
  });

  it("returns null — not a zero — for paths git counted nothing for", () => {
    expect(lineCountFor(counts, "untracked.ts")).toBeNull();
    expect(lineCountFor([], "a.ts")).toBeNull();
  });
});

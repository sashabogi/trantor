import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, patchForHunk, patchForLines } from "./diff";

describe("partial patch construction", () => {
  it("builds an applicable new-file patch with a one-based new start", () => {
    const file = parseUnifiedDiff(["diff --git a/new.txt b/new.txt", "new file mode 100644", "--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1,2 @@", "+one", "+two"].join("\n"))[0];
    const patch = patchForLines(file, file.hunks[0], new Set([1]));
    expect(patch).toContain("new file mode 100644");
    expect(patch).toContain("--- /dev/null\n+++ b/new.txt");
    expect(patch).toContain("@@ -0,0 +1,1 @@\n+two");
    expect(patchForHunk(file, file.hunks[0])).toContain("@@ -0,0 +1,2 @@");
  });

  it("in reverse keeps unselected additions as context and drops unselected deletions", () => {
    const file = parseUnifiedDiff(["diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -4,2 +8,3 @@", "-old", "+new1", "+new2", " tail"].join("\n"))[0];
    const patch = patchForLines(file, file.hunks[0], new Set([1]), true);
    expect(patch).toContain("@@ -8,2 +8,3 @@\n+new1\n new2\n tail");
    expect(patch).not.toContain("old");
  });

  it("keeps unselected deletions as context and drops unselected additions", () => {
    const file = parseUnifiedDiff(["diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -4,2 +8,2 @@", "-old", "+new", " tail"].join("\n"))[0];
    const patch = patchForLines(file, file.hunks[0], new Set([1]));
    expect(patch).toContain("@@ -4,2 +4,3 @@\n old\n+new\n tail");
  });
});

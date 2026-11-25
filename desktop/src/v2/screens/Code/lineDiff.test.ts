import { describe, expect, it } from "vitest";
import { diffLines, MAX_DIFF_CELLS } from "./lineDiff";

const t = (...lines: string[]) => lines.join("\n");

describe("diffLines", () => {
  it("finds nothing in identical text", () => {
    expect(diffLines(t("a", "b"), t("a", "b"))).toEqual([]);
  });
  it("treats CRLF and LF as the same line breaks", () => {
    expect(diffLines("a\r\nb", "a\nb")).toEqual([]);
  });
  it("marks an added run in the middle", () => {
    expect(diffLines(t("a", "d"), t("a", "b", "c", "d"))).toEqual([{ kind: "added", from: 2, to: 3 }]);
  });
  it("marks an added line at the first line", () => {
    expect(diffLines(t("b"), t("a", "b"))).toEqual([{ kind: "added", from: 1, to: 1 }]);
  });
  it("marks an added line at the last line", () => {
    expect(diffLines(t("a"), t("a", "b"))).toEqual([{ kind: "added", from: 2, to: 2 }]);
  });
  it("marks a changed run", () => {
    expect(diffLines(t("a", "b", "c", "d"), t("a", "X", "Y", "d"))).toEqual([{ kind: "changed", from: 2, to: 3 }]);
  });
  it("marks the extra lines of a longer change as added", () => {
    expect(diffLines(t("a", "b", "z"), t("a", "X", "Y", "z"))).toEqual([
      { kind: "changed", from: 2, to: 2 }, { kind: "added", from: 3, to: 3 },
    ]);
  });
  it("marks removed lines on the line that follows", () => {
    expect(diffLines(t("a", "b", "c"), t("a", "c"))).toEqual([{ kind: "removed", from: 2, to: 2 }]);
  });
  it("marks a removal at the first line", () => {
    expect(diffLines(t("a", "b"), t("b"))).toEqual([{ kind: "removed", from: 1, to: 1 }]);
  });
  it("marks a removal at the end past the last line", () => {
    expect(diffLines(t("a", "b"), t("a"))).toEqual([{ kind: "removed", from: 2, to: 2 }]);
  });
  it("keeps a removed mark after a shorter change", () => {
    expect(diffLines(t("a", "b", "c", "z"), t("a", "X", "z"))).toEqual([
      { kind: "changed", from: 2, to: 2 }, { kind: "removed", from: 3, to: 3 },
    ]);
  });
  it("marks the whole file when nothing is shared", () => {
    expect(diffLines(t("a", "b"), t("x", "y"))).toEqual([{ kind: "changed", from: 1, to: 2 }]);
  });
  it("marks lines added against an empty HEAD file", () => {
    expect(diffLines("", t("a", "b"))).toEqual([{ kind: "changed", from: 1, to: 1 }, { kind: "added", from: 2, to: 2 }]);
  });
  it("marks a removal when the file is emptied", () => {
    expect(diffLines(t("a", "b"), "")).toEqual([{ kind: "changed", from: 1, to: 1 }, { kind: "removed", from: 2, to: 2 }]);
  });
  it("skips markers above the size cap", () => {
    const side = Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 5;
    const old = Array.from({ length: side }, (_, i) => `o${i}`).join("\n");
    const next = Array.from({ length: side }, (_, i) => `n${i}`).join("\n");
    expect(diffLines(old, next)).toBeNull();
  });
});

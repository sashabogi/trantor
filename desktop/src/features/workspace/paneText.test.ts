// paneDiff is TerminalPane's only pure logic, so it carries the pane's whole test weight
// (the same pattern the review lens uses with parsePatch).
import { describe, expect, it } from "vitest";
import { paneDiff } from "./paneText";

describe("paneDiff", () => {
  it("appends the full text when the pane starts empty (first poll)", () => {
    expect(paneDiff("", "$ ls\nfile.txt\n")).toEqual({
      kind: "append",
      text: "$ ls\nfile.txt\n",
    });
  });

  it("writes nothing when the read is unchanged", () => {
    expect(paneDiff("$ ls\n", "$ ls\n")).toBeNull();
  });

  it("writes only the suffix when new output extends the old (the flicker fix)", () => {
    expect(paneDiff("$ ls\n", "$ ls\nfile.txt\n$ ")).toEqual({
      kind: "append",
      text: "file.txt\n$ ",
    });
  });

  it("returns null when next equals prev but startsWith also held (no empty write)", () => {
    expect(paneDiff("abc", "abc")).toBeNull();
  });

  it("replaces wholesale when the buffer shrank (a clear)", () => {
    expect(paneDiff("$ ls\nfile.txt\n$ ", "$ clear\n$ ")).toEqual({
      kind: "replace",
      text: "$ clear\n$ ",
    });
  });

  it("replaces wholesale when the content diverged mid-stream (TUI redraw)", () => {
    expect(paneDiff("abcdef", "abXef")).toEqual({ kind: "replace", text: "abXef" });
  });

  it("replaces when prev is empty but next is too (empty pane stays quiet)", () => {
    expect(paneDiff("", "")).toBeNull();
  });
});

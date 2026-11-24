// #13987 drill: every porcelain code the Explorer can meet maps to one letter, tone and plain label.
import { describe, expect, it } from "vitest";
import { LEGEND, countsLabel, decorate, decorateCode, decorationTitle, folderTitle, rollUp } from "./explorerStatus";

const glyphOf = (x: string, y: string) => { const d = decorate(x, y); return d && [d.letter, d.tone, d.label, d.staging]; };
const title = (x: string, y: string) => { const d = decorate(x, y); return d ? decorationTitle(d) : ""; };

describe("decorate", () => {
  it("maps modified, told apart by staging", () => {
    expect(glyphOf(" ", "M")).toEqual(["M", "warn", "Modified", "not staged"]);
    expect(glyphOf("M", " ")).toEqual(["M", "warn", "Modified", "staged"]);
    expect(glyphOf("M", "M")).toEqual(["M", "warn", "Modified", "partly staged"]);
  });
  it("maps added and untracked to green with different letters", () => {
    expect(glyphOf("A", " ")).toEqual(["A", "ok", "Added", "staged"]);
    expect(glyphOf("A", "M")).toEqual(["A", "ok", "Added", "partly staged"]);
    expect(glyphOf("?", "?")).toEqual(["U", "ok", "Untracked", ""]);
  });
  it("maps deleted to red, staged or not", () => {
    expect(glyphOf(" ", "D")).toEqual(["D", "bad", "Deleted", "not staged"]);
    expect(glyphOf("D", " ")).toEqual(["D", "bad", "Deleted", "staged"]);
  });
  it("maps renamed to blue", () => {
    expect(glyphOf("R", " ")).toEqual(["R", "accent", "Renamed", "staged"]);
    expect(glyphOf("R", "M")).toEqual(["R", "accent", "Renamed", "partly staged"]);
  });
  it("maps every conflict pair to red with the ! letter", () => {
    for (const [x, y] of [["U", "U"], ["A", "A"], ["D", "D"], ["A", "U"], ["U", "D"], ["D", "U"]]) {
      expect(glyphOf(x, y)).toEqual(["!", "bad", "Conflicted", ""]);
    }
  });
  it("has nothing to say for clean and ignored paths", () => {
    expect(decorate(" ", " ")).toBeNull();
    expect(decorate("!", "!")).toBeNull();
    expect(decorate("", "")).toBeNull();
  });
  it("words the tooltip with the staging", () => {
    expect(title(" ", "M")).toBe("Modified, not staged");
    expect(title("?", "?")).toBe("Untracked");
  });
  it("gives every meaning its own letter, so colour is not the only signal", () => {
    expect(new Set(LEGEND.map(l => l.letter)).size).toBe(LEGEND.length);
  });
});

describe("decorateCode", () => {
  it("reads the listing's trimmed code and makes no staging claim", () => {
    expect(decorateCode("M")).toMatchObject({ letter: "M", staging: "" });
    expect(decorateCode("??")).toMatchObject({ letter: "U" });
    expect(decorateCode("A")).toMatchObject({ letter: "A", staging: "" });
    expect(decorateCode("")).toBeNull();
  });
});

describe("rollUp", () => {
  it("counts changed files per ancestor and keeps the most important change", () => {
    const m = rollUp([
      { path: "src/a/new.ts", x: "?", y: "?" },
      { path: "src/a/edit.ts", x: " ", y: "M" },
      { path: "src/b/gone.ts", x: " ", y: "D" },
      { path: "docs/x.md", x: "?", y: "?" },
    ]);
    expect(m.get("src/a")).toMatchObject({ count: 2, top: { letter: "M" } });
    expect(m.get("src")).toMatchObject({ count: 3, top: { letter: "D" } });
    expect(m.get("docs")).toMatchObject({ count: 1, top: { letter: "U" } });
    expect(m.has("src/a/new.ts")).toBe(false);
  });
  it("lets a conflict outrank deleted and modified", () => {
    const m = rollUp([{ path: "d/a", x: " ", y: "D" }, { path: "d/b", x: "U", y: "U" }, { path: "d/c", x: " ", y: "M" }]);
    expect(m.get("d")?.top.letter).toBe("!");
  });
  it("ranks added/untracked lowest", () => {
    expect(rollUp([{ path: "d/a", x: "?", y: "?" }, { path: "d/b", x: " ", y: "M" }]).get("d")?.top.letter).toBe("M");
  });
});

describe("labels", () => {
  it("words folders and line counts", () => {
    expect(folderTitle(3)).toBe("3 changed files inside");
    expect(folderTitle(1)).toBe("1 changed file inside");
    expect(countsLabel(12, 3)).toBe("+12 −3");
    expect(countsLabel(null, null)).toBe("");
    expect(countsLabel(undefined, 2)).toBe("");
  });
});

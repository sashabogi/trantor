import { describe, expect, it } from "vitest";
import { decorationsFor } from "./useChangeMarkers";

const colors = { added: "var(--v2-ok)", changed: "var(--v2-warn)", removed: "var(--v2-bad)" };

describe("decorationsFor", () => {
  it("draws added and changed runs as whole-line gutter bars with ruler marks", () => {
    const [added, changed] = decorationsFor([{ kind: "added", from: 2, to: 3 }, { kind: "changed", from: 5, to: 5 }], 10, colors);
    expect(added.range).toMatchObject({ startLineNumber: 2, endLineNumber: 3 });
    expect(added.options.linesDecorationsClassName).toBe("v2-cm-added");
    expect(added.options.overviewRuler?.color).toBe("var(--v2-ok)");
    expect(changed.options.linesDecorationsClassName).toBe("v2-cm-changed");
  });
  it("draws a removal on the line that follows the gap", () => {
    const [removed] = decorationsFor([{ kind: "removed", from: 4, to: 4 }], 10, colors);
    expect(removed.options.linesDecorationsClassName).toBe("v2-cm-removed");
    expect(removed.range.startLineNumber).toBe(4);
  });
  it("draws a removal past the end on the bottom of the last line", () => {
    const [removed] = decorationsFor([{ kind: "removed", from: 11, to: 11 }], 10, colors);
    expect(removed.options.linesDecorationsClassName).toBe("v2-cm-removed-below");
    expect(removed.range.startLineNumber).toBe(10);
  });
});

// The grid must tile the way crew.sh tiles real panes, or the app and the multiplexer disagree
// about what a crew of N looks like.
import { describe, expect, it } from "vitest";
import { gridCols } from "./Workspace";

describe("gridCols", () => {
  it("keeps a single seat full width", () => {
    expect(gridCols(1)).toBe(1);
  });

  it("pairs two and four seats into square-ish grids", () => {
    expect(gridCols(2)).toBe(2);
    expect(gridCols(4)).toBe(2);
  });

  it("grows a column only when the square no longer fits", () => {
    expect(gridCols(5)).toBe(3);
    expect(gridCols(9)).toBe(3);
    expect(gridCols(10)).toBe(4);
  });

  it("never returns zero columns, which would collapse the grid", () => {
    expect(gridCols(0)).toBe(1);
  });
});

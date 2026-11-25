// @vitest-environment happy-dom
// #14268: arrow keys walk tabs and wrap at the ends.
import { describe, expect, it } from "vitest";
import { arrowTarget } from "./arrowKeys";

describe("arrowTarget", () => {
  it("moves right and left and wraps", () => {
    expect(arrowTarget("ArrowRight", 0, 3)).toBe(1);
    expect(arrowTarget("ArrowRight", 2, 3)).toBe(0);
    expect(arrowTarget("ArrowLeft", 0, 3)).toBe(2);
    expect(arrowTarget("a", 0, 3)).toBe(-1);
    expect(arrowTarget("ArrowDown", 0, 3, true)).toBe(1);
  });
});

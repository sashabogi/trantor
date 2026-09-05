import { describe, expect, it } from "vitest";
import { chipFrom, type BalanceRow } from "./balanceChips";

// #6391 real path (2026-09-04): the Accounts pane blanked the whole app because chipFrom read
// `.slice` on an undefined name for a usage row without label or provider.
describe("chipFrom never throws over a nameless usage row", () => {
  const shapes: Array<Partial<BalanceRow>> = [
    { kind: "windows", ok: true, windows: [{ name: "7d", usedPct: 3, resetsAt: Date.now() + 3600e3, locked: null }] },
    { kind: "quota", ok: true, remainingPct: null, detail: "100% in 5h window" },
    { kind: "prepaid", ok: true, usage: 34.1 },
    { kind: "quota", ok: false, error: "unreachable" },
    {},
  ];
  for (const [i, shape] of shapes.entries()) {
    it(`shape ${i} renders a chip or null, never throws`, () => {
      // SAFETY: the test deliberately feeds partial rows; the function must tolerate them.
      const row = shape as BalanceRow;
      expect(() => chipFrom(row)).not.toThrow();
    });
  }
});

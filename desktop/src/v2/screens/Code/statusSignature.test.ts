import { describe, expect, it } from "vitest";
import { statusSignature } from "./SourceControlTab";
import type { ScopeSnapshot } from "./useScopeGit";

const snap = (plus: number, minus: number): ScopeSnapshot => ({
  scope: null, branch: "main", upstream: "origin/main", remote: "origin", ahead: 1, behind: 0,
  status: [{ path: "src/a.ts", x: " ", y: "M" }], counts: [{ path: "src/a.ts", plus, minus }],
  log: [], seatBacked: false, readAt: 0,
});

describe("statusSignature", () => {
  it("moves when only the line counts move, so the diff is read again after a hunk or line discard", () => {
    expect(statusSignature(snap(1, 1))).not.toBe(statusSignature(snap(0, 1)));
    expect(statusSignature(snap(1, 1))).toBe(statusSignature(snap(1, 1)));
  });
});

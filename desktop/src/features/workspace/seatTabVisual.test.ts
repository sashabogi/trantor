// The seat tab's visual contract, pinned (#5890): motion ONLY for a running turn, amber ONLY for
// blocked, still otherwise — and the title always says the state in words.
import { describe, expect, it } from "vitest";
import { seatTabVisual } from "./seatTabVisual";
import { brandFor } from "../../shared/Avatar";

describe("seatTabVisual", () => {
  it("a working turn pulses and says so", () => {
    const v = seatTabVisual("working", "codex");
    expect(v).toEqual({ state: "working", title: "codex — working", pulse: true, amber: false });
  });

  it("herdr's 'busy' is a running turn too", () => {
    const v = seatTabVisual("busy", "glm");
    expect(v.state).toBe("working");
    expect(v.pulse).toBe(true);
    expect(v.amber).toBe(false);
  });

  it("blocked is amber, still — attention without noise", () => {
    const v = seatTabVisual("blocked", "kimi");
    expect(v).toEqual({ state: "blocked", title: "kimi — blocked, waiting on you", pulse: false, amber: true });
  });

  it("idle, unknown, and absent statuses are all still and quiet", () => {
    for (const s of ["idle", "offline", "", undefined]) {
      const v = seatTabVisual(s, "deepseek");
      expect(v).toEqual({ state: "idle", title: "deepseek — idle", pulse: false, amber: false });
    }
  });

  it("status matching is case-insensitive and whitespace-tolerant", () => {
    expect(seatTabVisual("  Working ", "codex").state).toBe("working");
    expect(seatTabVisual("BLOCKED", "codex").amber).toBe(true);
  });

  it("the qwen seat tabs like every other seat — and wears the real mark, not the qw monogram (#6006)", () => {
    for (const [status, expected] of [
      ["working", { state: "working", title: "qwen — working", pulse: true, amber: false }],
      ["blocked", { state: "blocked", title: "qwen — blocked, waiting on you", pulse: false, amber: true }],
      ["idle", { state: "idle", title: "qwen — idle", pulse: false, amber: false }],
    ] as const) {
      expect(seatTabVisual(status, "qwen")).toEqual(expected);
    }
    // The brand registry resolves the vendored monochrome mark: currentColor fill, the same
    // 24x24 box as every other glyph — the one registry SeatTab, sidebar rows, board chips
    // and Sessions all read.
    const brand = brandFor("qwen:trantor");
    expect(brand?.label).toBe("Qwen");
    expect(brand?.svg).toContain('fill="currentColor"');
    expect(brand?.svg).toContain('viewBox="0 0 24 24"');
    expect(brand?.hex).toBe("#6336E7");
  });
});

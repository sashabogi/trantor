// The seat tab's visual contract, pinned (#5890): motion ONLY for a running turn, amber ONLY for
// blocked, still otherwise — and the title always says the state in words. #5965 adds the "down"
// leg: the runner's `down:`/`errored:` hub statuses read as down (failure ring), never idle.
import { describe, expect, it } from "vitest";
import { seatTabVisual } from "./seatTabVisual";

describe("seatTabVisual", () => {
  it("a working turn pulses and says so", () => {
    const v = seatTabVisual("working", "codex");
    expect(v).toEqual({ state: "working", title: "codex — working", pulse: true, amber: false, down: false });
  });

  it("herdr's 'busy' is a running turn too", () => {
    const v = seatTabVisual("busy", "glm");
    expect(v.state).toBe("working");
    expect(v.pulse).toBe(true);
    expect(v.amber).toBe(false);
    expect(v.down).toBe(false);
  });

  it("blocked is amber, still — attention without noise", () => {
    const v = seatTabVisual("blocked", "kimi");
    expect(v).toEqual({ state: "blocked", title: "kimi — blocked, waiting on you", pulse: false, amber: true, down: false });
  });

  it("idle, unknown, and absent statuses are all still and quiet", () => {
    for (const s of ["idle", "offline", "", undefined]) {
      const v = seatTabVisual(s, "deepseek");
      expect(v).toEqual({ state: "idle", title: "deepseek — idle", pulse: false, amber: false, down: false });
    }
  });

  it("status matching is case-insensitive and whitespace-tolerant", () => {
    expect(seatTabVisual("  Working ", "codex").state).toBe("working");
    expect(seatTabVisual("BLOCKED", "codex").amber).toBe(true);
  });

  // #5965 — the runner's hub status is the source of truth for a runner-driven seat (herdr skips
  // screen detection for it, so its herdr row stays "idle" mid-turn). The tab must read those.
  it("the runner's 'working · <trigger>' hub status pulses", () => {
    const v = seatTabVisual("working · direct message", "kimi");
    expect(v).toEqual({ state: "working", title: "kimi — working", pulse: true, amber: false, down: false });
  });

  it("the runner's 'down: <reason>' reads as down, not idle", () => {
    const v = seatTabVisual("down: exhausted · 2 fails", "codex");
    expect(v).toEqual({ state: "down", title: "codex — down", pulse: false, amber: false, down: true });
  });

  it("the runner's 'errored: <reason>' reads as down, not idle", () => {
    const v = seatTabVisual("errored: auth", "deepseek");
    expect(v).toEqual({ state: "down", title: "deepseek — down", pulse: false, amber: false, down: true });
  });

  it("the runner's clean 'idle' turn end is still", () => {
    const v = seatTabVisual("idle", "qwen");
    expect(v).toEqual({ state: "idle", title: "qwen — idle", pulse: false, amber: false, down: false });
  });
});

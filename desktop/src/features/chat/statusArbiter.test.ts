// Arbitration drills (#6146): the seed/push race that left pr-os's composer disabled while the
// pane was actually working, and the bounded re-seed schedule that recovers from a missed push.
// Pure inputs, pure assertions — no window, no vi.mock.
import { describe, expect, it } from "vitest";
import {
  apply, initialArbiterState, needsReseed, RESEED_DELAYS_MS, type ArbiterState,
} from "./statusArbiter";

describe("apply — seq order decides, arrival order does not", () => {
  it("a later push wins over an earlier-dispatched seed, even if the seed resolves last", () => {
    // The seed was DISPATCHED first (seq 0), but its promise settles after a push that was
    // RECEIVED later (seq 1) already landed. Applying the late seed must not undo the push.
    let s: ArbiterState = initialArbiterState;
    s = apply(s, { source: "push", seq: 1, value: "working" });
    expect(s.value).toBe("working");
    s = apply(s, { source: "seed", seq: 0, value: "none" });
    expect(s.value).toBe("working");
    expect(s.seq).toBe(1);
  });

  it("late seed does not overwrite a newer push (in dispatch order too)", () => {
    let s: ArbiterState = initialArbiterState;
    s = apply(s, { source: "seed", seq: 0, value: "none" });
    expect(s.value).toBe("none");
    s = apply(s, { source: "push", seq: 1, value: "blocked" });
    expect(s.value).toBe("blocked");
    // A seed that was in flight before the push (seq 0) resolving now must still lose.
    s = apply(s, { source: "seed", seq: 0, value: "none" });
    expect(s.value).toBe("blocked");
    expect(s.seq).toBe(1);
  });

  it("a genuinely newer seed (re-seed dispatched after the push) does win", () => {
    let s: ArbiterState = initialArbiterState;
    s = apply(s, { source: "push", seq: 0, value: "none" });
    s = apply(s, { source: "seed", seq: 1, value: "working" });
    expect(s.value).toBe("working");
  });

  it("an equal seq is a duplicate/late arrival and changes nothing", () => {
    let s: ArbiterState = initialArbiterState;
    s = apply(s, { source: "push", seq: 3, value: "working" });
    const before = s;
    s = apply(s, { source: "push", seq: 3, value: "blocked" });
    expect(s).toBe(before);
    expect(s.value).toBe("working");
  });

  it("the very first event (seq 0) always applies against the initial state", () => {
    const s = apply(initialArbiterState, { source: "seed", seq: 0, value: "idle" });
    expect(s.value).toBe("idle");
  });
});

describe("needsReseed / RESEED_DELAYS_MS — the bounded recovery schedule", () => {
  it("'none' triggers the bounded re-seed schedule", () => {
    expect(needsReseed("none")).toBe(true);
  });

  it("'unknown' (never seeded) also triggers it", () => {
    expect(needsReseed("unknown")).toBe(true);
  });

  it("a real status closes the schedule — nothing left for it to fix", () => {
    for (const st of ["working", "blocked", "idle", "ended"]) {
      expect(needsReseed(st)).toBe(false);
    }
  });

  it("the schedule is finite and strictly increasing — never an unbounded poll", () => {
    expect(RESEED_DELAYS_MS.length).toBeGreaterThan(0);
    expect(RESEED_DELAYS_MS.length).toBeLessThanOrEqual(6);
    for (let i = 1; i < RESEED_DELAYS_MS.length; i++) {
      expect(RESEED_DELAYS_MS[i]).toBeGreaterThan(RESEED_DELAYS_MS[i - 1]);
    }
  });
});

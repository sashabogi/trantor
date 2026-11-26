// #14351: one state language for tabs, tiles, rows and the hover card.
import { describe, expect, it } from "vitest";
import { activityLine, seatState, stateDot } from "./identity";

const seat = (presence: "working" | "needs-you" | "ready" | "offline", words: string, status?: string, isOrchestrator = false) => ({ presence, words, isOrchestrator, target: { status } });

describe("seat state language", () => {
  it("needs you overrides every other state and says what", () => {
    expect(seatState({ presence: "needs-you", words: "waiting on glm-5" })).toBe("needs");
    expect(activityLine(seat("needs-you", "needs you"), { needs: "approve push" })).toBe("needs you: approve push");
    expect(activityLine(seat("needs-you", "needs you"))).toBe("needs you");
  });

  it("waiting is lavender and solid, working pulses, idle and offline are hollow faint rings", () => {
    expect(stateDot("waiting").style.background).toBe("var(--v2-proposal)");
    expect(stateDot("waiting").className).toBe("");
    expect(stateDot("working")).toEqual({ className: "v2-pulse", style: { background: "var(--v2-accent)" } });
    expect(stateDot("ready").style.background).toBe("var(--v2-ok)");
    expect(stateDot("needs").style.background).toBe("var(--v2-warn)");
    for (const s of ["idle", "offline"] as const) {
      expect(stateDot(s).style.background).toBe("transparent");
      expect(stateDot(s).style.boxShadow).toContain("var(--v2-faint)");
    }
  });

  it("derives short human activity lines", () => {
    expect(seatState({ presence: "ready", words: "waiting on glm-5" })).toBe("waiting");
    expect(activityLine(seat("ready", "waiting on glm-5"), { waitingOn: "glm-5" })).toBe("waiting on glm-5");
    expect(activityLine(seat("working", "working", "working · running tests"))).toBe("running tests");
    expect(activityLine(seat("working", "working", "working · card 13970"))).toBe("working on card 13970");
    expect(activityLine(seat("working", "working", "working"))).toBe("working");
    expect(activityLine(seat("ready", "ready"))).toBe("ready");
    expect(seatState({ presence: "ready", words: "finished" })).toBe("idle");
    expect(activityLine(seat("offline", "offline"))).toBe("offline");
  });

  it("the orchestrator says you only when it is not doing anything", () => {
    expect(activityLine(seat("ready", "ready", undefined, true))).toBe("you");
    expect(activityLine(seat("working", "working", "working · reviewing the plan", true))).toBe("reviewing the plan");
  });
});

// #14365: codex-8's account hit its usage limit and the runner parked it until next month, but the
// tab gave a thumbs up as if it were ready. A parked or stalled seat sleeps and says why.
describe("benched seats", () => {
  it("a parked or stalled seat sleeps, and its line says why", () => {
    const parked = { presence: "ready" as const, words: "parked (exhausted)" };
    expect(seatState(parked)).toBe("idle");
    expect(activityLine(parked)).toBe("parked (exhausted)");
    expect(seatState({ presence: "ready", words: "stalled · no activity" })).toBe("idle");
    expect(seatState({ presence: "ready", words: "ready" })).toBe("ready");
  });
});

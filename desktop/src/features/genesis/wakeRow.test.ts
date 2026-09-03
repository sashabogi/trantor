import { describe, expect, it } from "vitest";
import { classifyWakeOutcome, wakeOutcomeIsTransient, wakeRowLine, WAKE_OUTCOME_MS, WAKE_PENDING_LINE, WAKE_SENT_LINE, type WakeRowState } from "./wakeRow";

describe("wakeRow states (#6138)", () => {
  it("reads the idle-pane path as kickoff sent, the reopen path as woken", () => {
    // The Rust lines are contracts — genesis.rs returns these exact prefixes.
    const sent = classifyWakeOutcome("kickoff sent into idle pane wJ:p1 · kickoff: prompt delivered · 1 attempt(s), 0s", null);
    expect(sent).toEqual({ phase: "outcome", kind: "sent", text: expect.stringContaining("kickoff sent") });
    const woken = classifyWakeOutcome("project awake in pane wJ:p1 · kickoff: prompt delivered · 2 attempt(s), 4s", null);
    expect(woken).toEqual({ phase: "outcome", kind: "woken", text: expect.stringContaining("project awake") });
  });

  it("reads a busy pane as busy, anything else as the error", () => {
    const busy = classifyWakeOutcome(null, "pr-os is busy in pane wJ:p1 — the orchestrator is mid-turn");
    expect(busy.kind).toBe("busy");
    expect(busy.text).toContain("busy in pane wJ:p1");
    const failed = classifyWakeOutcome(null, "no local checkout for ghost");
    expect(failed.kind).toBe("error");
    expect(classifyWakeOutcome(null, undefined as unknown as string).kind).toBe("error");
  });

  it("errors stay on the row; woken, kickoff sent and busy fade after the few seconds", () => {
    expect(WAKE_OUTCOME_MS).toBeGreaterThanOrEqual(3000);
    const error = classifyWakeOutcome(null, "hub down") as Extract<WakeRowState, { phase: "outcome" }>;
    expect(wakeOutcomeIsTransient(error)).toBe(false);
    for (const kind of ["sent", "woken", "busy"] as const) {
      expect(wakeOutcomeIsTransient({ phase: "outcome", kind, text: "x" })).toBe(true);
    }
  });

  it("the row line names each state in the operator's words", () => {
    expect(wakeRowLine({ phase: "running" })).toEqual({ text: "waking…", tone: "muted" });
    expect(wakeRowLine({ phase: "kickoff", step: "pending" })).toEqual({ text: WAKE_PENDING_LINE, tone: "muted" });
    expect(wakeRowLine({ phase: "kickoff", step: "sent" })).toEqual({ text: WAKE_SENT_LINE, tone: "muted" });
    expect(wakeRowLine({ phase: "outcome", kind: "sent", text: "kickoff sent into idle pane wJ:p1" })?.text).toBe("kickoff sent");
    expect(wakeRowLine({ phase: "outcome", kind: "woken", text: "project awake in pane p" })?.text).toBe("woken");
    expect(wakeRowLine({ phase: "outcome", kind: "busy", text: "busy in pane p" })?.tone).toBe("muted");
    expect(wakeRowLine({ phase: "outcome", kind: "error", text: "no checkout" })?.text).toBe("wake failed — click Wake to retry");
    expect(wakeRowLine(undefined)).toBeNull();
  });
});

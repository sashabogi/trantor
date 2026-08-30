// #5609 — a card's face tells the truth about life, drilled on the pure rule.
import { describe, expect, it } from "vitest";
import { cardLiveness } from "./Board";

describe("cardLiveness", () => {
  it("doing + busy assignee breathes", () => {
    expect(cardLiveness("doing", "busy").inMotion).toBe(true);
  });

  it("testing + busy assignee ALSO breathes — verification is work", () => {
    const v = cardLiveness("testing", "busy");
    expect(v.inMotion).toBe(true);
    expect(v.awaitingVerdict).toBe(false);
  });

  it("testing with a quiet assignee says AWAITING VERDICT — the operator's move, named", () => {
    expect(cardLiveness("testing", "idle").awaitingVerdict).toBe(true);
    expect(cardLiveness("testing", "offline").awaitingVerdict).toBe(true);
    expect(cardLiveness("testing", undefined).awaitingVerdict).toBe(true);
  });

  it("doing with a dead assignee stalls; done/todo never wear liveness", () => {
    expect(cardLiveness("doing", "offline").stalled).toBe(true);
    expect(cardLiveness("doing", undefined).stalled).toBe(true);
    expect(cardLiveness("doing", "idle").stalled).toBe(false);
    for (const s of ["done", "todo", "stale"]) {
      const v = cardLiveness(s, "busy");
      expect(v.inMotion).toBe(false);
      expect(v.awaitingVerdict).toBe(false);
    }
  });

  it("failed and blocked alarm regardless of presence", () => {
    expect(cardLiveness("failed", "busy").alarmed).toBe(true);
    expect(cardLiveness("blocked", undefined).alarmed).toBe(true);
  });
});

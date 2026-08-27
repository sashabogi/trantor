// One clock for every surface: a timestamp says its day the moment it is no longer today.
// "8:33 PM" with no date is an anti-timestamp — these tests pin exactly when the day appears.
import { describe, expect, it } from "vitest";
import { clock, when } from "./time";

// Anchor at noon so the today/yesterday boundary never wobbles with the wall clock the test
// happens to run against (running this at 00:30 must not flip a case over midnight).
const NOON = new Date();
NOON.setHours(12, 0, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("when", () => {
  it("today shows the clock only — no day attached", () => {
    const ts = NOON.getTime() - HOUR;
    expect(when(ts)).toBe(clock(ts));
    expect(when(ts)).not.toMatch(/yesterday/i);
  });

  it("yesterday says yesterday", () => {
    const ts = NOON.getTime() - DAY;
    expect(when(ts)).toBe(`yesterday ${clock(ts)}`);
  });

  it("within the week the day is the weekday", () => {
    const ts = NOON.getTime() - 3 * DAY;
    const weekday = new Date(ts).toLocaleDateString([], { weekday: "short" });
    expect(when(ts)).toBe(`${weekday} ${clock(ts)}`);
  });

  it("beyond a week the day is the month and date", () => {
    const ts = NOON.getTime() - 30 * DAY;
    const day = new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
    expect(when(ts)).toBe(`${day}, ${clock(ts)}`);
  });
});

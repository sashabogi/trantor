// Duty liveness drills (#5688): what the strip shows, and the one edge that earns a
// notification. Pure assertions over the pure module — the /health fetch itself stays behind
// the Rust bridge and is not exercised here.
import { describe, expect, it } from "vitest";
import { darkDuration, dutyDarkEdge, dutyIsDark, lastSeenAgo, type DutyHealth } from "./dutyHealth";

const health = (d: Partial<DutyHealth>): DutyHealth => ({
  configured: true, online: true, lastSeenMs: 0, darkSinceMs: 0, queuedEscalations: 0, ...d,
});

describe("dutyIsDark — the strip exists only for a configured seat that is dark", () => {
  it("configured + offline = dark", () => {
    expect(dutyIsDark(health({ online: false, darkSinceMs: 60_000 }))).toBe(true);
  });
  it("configured + online is not dark", () => {
    expect(dutyIsDark(health({}))).toBe(false);
  });
  it("no duty seat configured is honest silence, not a red banner", () => {
    expect(dutyIsDark(health({ configured: false, online: false }))).toBe(false);
  });
  it("an unreachable hub (null read) shows nothing", () => {
    expect(dutyIsDark(null)).toBe(false);
  });
});

describe("dutyDarkEdge — one notification per episode, on a transition we watched", () => {
  const up = health({});
  const dark = health({ online: false, darkSinceMs: 60_000, lastSeenMs: 900_000 });
  it("healthy → dark fires", () => {
    expect(dutyDarkEdge(up, dark)).toBe(true);
  });
  it("dark → dark stays silent (once per episode)", () => {
    expect(dutyDarkEdge(dark, dark)).toBe(false);
  });
  it("a first read that is already dark predates the window — the strip says it, no siren", () => {
    expect(dutyDarkEdge(null, dark)).toBe(false);
  });
  it("dark → healthy clears the edge", () => {
    expect(dutyDarkEdge(dark, up)).toBe(false);
  });
  it("a hub blip (null read) neither fires nor clears the episode", () => {
    expect(dutyDarkEdge(up, null)).toBe(false);
    expect(dutyDarkEdge(null, dark)).toBe(false);
  });
});

describe("the strip's relative vocabulary", () => {
  it("darkDuration reads as a duration, not a date", () => {
    expect(darkDuration(30_000)).toBe("under a minute");
    expect(darkDuration(12 * 60_000)).toBe("12m");
    expect(darkDuration(2 * 3_600_000 + 5 * 60_000)).toBe("2h 5m");
    expect(darkDuration(2 * 3_600_000)).toBe("2h");
  });
  it("lastSeenAgo mirrors the drill-in's freshness words", () => {
    expect(lastSeenAgo(30_000)).toBe("under a minute");
    expect(lastSeenAgo(14 * 60_000)).toBe("14m");
    expect(lastSeenAgo(3 * 3_600_000)).toBe("3h");
  });
});

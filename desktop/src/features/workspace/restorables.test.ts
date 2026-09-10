import { describe, expect, it } from "vitest";
import { restoreSettled, settleEntries, visibleRestorables, type DismissedSession } from "./restorables";
import type { RestorableSession } from "./herdr";

const session = (project: string, sessionId: string): RestorableSession => ({ project, sessionId });
const dismissal = (project: string, sessionId: string, ts = 1): DismissedSession => ({ project, sessionId, ts });

describe("visibleRestorables", () => {
  it("persist: a dismissed session stays filtered out on the next read", () => {
    const candidates = [session("tiny-timer", "wM:p1"), session("hive-digital", "wN:p1")];
    const dismissed = [dismissal("tiny-timer", "wM:p1")];
    expect(visibleRestorables(candidates, dismissed)).toEqual([session("hive-digital", "wN:p1")]);
  });

  it("wake-clears: once a dismissal is cleared (removed from the durable list), the project shows again", () => {
    const candidates = [session("tiny-timer", "wM:p1")];
    // Wake clears the durable record — an empty dismissed list is what that looks like on the
    // next read, since dismissedSessions.clear() removes the project's rows on disk.
    expect(visibleRestorables(candidates, [])).toEqual(candidates);
  });

  it("new-session-shows: a NEW dead session for a dismissed project is not hidden by the old dismissal", () => {
    const candidates = [session("tiny-timer", "wM:p9")]; // a fresh pane handle, not the dismissed one
    const dismissed = [dismissal("tiny-timer", "wM:p1")];
    expect(visibleRestorables(candidates, dismissed)).toEqual(candidates);
  });

  it("leaves everything visible when nothing is dismissed", () => {
    const candidates = [session("a", "1"), session("b", "2")];
    expect(visibleRestorables(candidates, [])).toEqual(candidates);
  });
});

// #7269: herdr's restore re-runs `claude --resume` the same second the app boots; the strip's
// launch snapshot must settle over re-polls instead of freezing on that first racing read.
describe("settleEntries (the #7269 restore race)", () => {
  it("drop-on-live: a pane whose agent registered between polls drops out", () => {
    const ask = new Set(["tiny-timer", "hive-digital"]);
    const fresh = [session("hive-digital", "wN:p1")]; // tiny-timer's claude is live now
    expect(settleEntries(ask, fresh, [])).toEqual([session("hive-digital", "wN:p1")]);
  });

  it("never-alive-still-shows: a pane dead through the whole settle window keeps its Resume row", () => {
    const ask = new Set(["drill-2"]);
    const fresh = [session("drill-2", "w2N:p1")];
    expect(settleEntries(ask, fresh, [])).toEqual(fresh);
  });

  it("an auto-woken project never shows, even while its row still reads dead", () => {
    const ask = new Set<string>(); // drill-2 was classified baton=auto and woken once
    const fresh = [session("drill-2", "w2N:p1")];
    expect(settleEntries(ask, fresh, [])).toEqual([]);
  });

  it("dismissals filter every pass, still keyed on (project, sessionId) (#6476)", () => {
    const ask = new Set(["tiny-timer"]);
    const fresh = [session("tiny-timer", "wM:p1"), session("tiny-timer", "wM:p9")];
    const dismissed = [dismissal("tiny-timer", "wM:p1")];
    expect(settleEntries(ask, fresh, dismissed)).toEqual([session("tiny-timer", "wM:p9")]);
  });
});

describe("restoreSettled (the #7269 settle check)", () => {
  it("a first poll alone is never settled", () => {
    expect(restoreSettled(null, [session("a", "1")])).toBe(false);
  });

  it("two agreeing polls settle the window, row order notwithstanding", () => {
    const first = [session("a", "1"), session("b", "2")];
    expect(restoreSettled(first, [session("b", "2"), session("a", "1")])).toBe(true);
  });

  it("an entry dropping (its pane went live) keeps the window open", () => {
    const prev = [session("a", "1"), session("b", "2")];
    expect(restoreSettled(prev, [session("b", "2")])).toBe(false);
  });
});

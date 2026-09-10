import { describe, expect, it } from "vitest";
import { retainFresh, settleEntries, visibleRestorables, type DismissedSession } from "./restorables";
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

// #7269: later polls may only DROP. The restored claudes register late under boot load, so the
// loop polls while the strip is non-empty — but nothing may ever re-enter it, or a session that
// exited on its own after launch would be nagged forever.
describe("retainFresh (later polls only drop)", () => {
  it("an entry whose pane came alive drops out", () => {
    const current = [session("tiny-timer", "wM:p1"), session("hive-digital", "wN:p1")];
    const fresh = [session("hive-digital", "wN:p1")]; // tiny-timer's claude is live now
    expect(retainFresh(current, fresh)).toEqual([session("hive-digital", "wN:p1")]);
  });

  it("never adds: a project the strip never showed cannot appear, even when fresh reports it dead", () => {
    const current = [session("a", "1")];
    const fresh = [session("a", "1"), session("b", "9")]; // b died after launch — not our nag
    expect(retainFresh(current, fresh)).toEqual([session("a", "1")]);
  });

  it("a pane that dropped on live is not re-added when it dies again", () => {
    expect(retainFresh([], [session("drill-2", "w2N:p1")])).toEqual([]);
  });

  it("a changed sessionId drops the old entry rather than re-showing it", () => {
    const current = [session("tiny-timer", "wM:p1")];
    expect(retainFresh(current, [session("tiny-timer", "wM:p9")])).toEqual([]);
  });
});

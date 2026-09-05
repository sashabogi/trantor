import { describe, expect, it } from "vitest";
import { visibleRestorables, type DismissedSession } from "./restorables";
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

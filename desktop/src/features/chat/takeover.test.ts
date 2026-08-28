// Takeover drills (#5495 / #5479): every branch of the pure helper, the two-candidate case,
// and the boundary the CLI's idle gate refuses under. Pure inputs, pure assertions — no window.
import { describe, expect, it } from "vitest";
import {
  newestTerminal, takeoverAction, TAKEOVER_IDLE_AFTER_SEC,
  type ProjectSessions, type SessionRow,
} from "./takeover";

const row = (r: Partial<SessionRow>): SessionRow => ({
  kind: "terminal", pid: null, sessionId: null, state: null, activeAgoSec: null, transcript: null, ...r,
});
const inv = (...rows: SessionRow[]): ProjectSessions => ({ sessions: rows });

describe("takeoverAction — the four branches", () => {
  it("offers Start when the inventory is empty — nothing is running", () => {
    const a = takeoverAction(inv());
    expect(a?.label).toBe("Start the orchestrator here");
    expect(a?.enabled).toBe(true);
  });

  it("offers Reopen for a pane whose agent exited", () => {
    const a = takeoverAction(inv(row({ kind: "pane", state: "none" })));
    expect(a?.label).toBe("Reopen");
    expect(a?.enabled).toBe(true);
  });

  it("continues an idle Terminal conversation, naming its freshness", () => {
    const a = takeoverAction(inv(row({ pid: 4242, sessionId: "s1", activeAgoSec: 60 })));
    expect(a?.label).toBe("Continue this conversation in Trantor");
    expect(a?.enabled).toBe(true);
    expect(a?.why).toContain("Terminal window");
    expect(a?.why).toContain("last active 60s ago");
  });

  it("holds the same button through a mid-turn conversation, saying why", () => {
    const a = takeoverAction(inv(row({ activeAgoSec: TAKEOVER_IDLE_AFTER_SEC - 1 })));
    expect(a?.label).toBe("Continue this conversation in Trantor");
    expect(a?.enabled).toBe(false);
    expect(a?.why).toContain("mid-turn");
    expect(a?.why).toContain("turn boundary");
  });
});

describe("takeoverAction — evidence rules", () => {
  it("offers nothing before the inventory has been read — no evidence, no action", () => {
    expect(takeoverAction(null)).toBeNull();
  });

  it("offers nothing while a live pane runs the conversation", () => {
    expect(takeoverAction(inv(row({ kind: "pane", state: "idle" })))).toBeNull();
    expect(takeoverAction(inv(row({ kind: "pane", state: "working", sessionId: "s1" })))).toBeNull();
  });

  it("treats the idle boundary exactly as the CLI gate does — 15s IS idle", () => {
    expect(takeoverAction(inv(row({ activeAgoSec: TAKEOVER_IDLE_AFTER_SEC })))?.enabled).toBe(true);
  });

  it("counts a Terminal claude with no fresh transcript as idle — quiet is not mid-turn", () => {
    const a = takeoverAction(inv(row({ activeAgoSec: null, sessionId: null })));
    expect(a?.enabled).toBe(true);
    expect(a?.why).toContain("quiet for over an hour");
  });

  it("treats an unanswered pane state like a dead agent — herdr vouches for nothing", () => {
    expect(takeoverAction(inv(row({ kind: "pane", state: null })))?.label).toBe("Reopen");
    expect(takeoverAction(inv(row({ kind: "pane", state: "unknown" })))?.label).toBe("Reopen");
  });

  it("a Terminal conversation outranks a dead pane — the CLI chain checks it first", () => {
    const a = takeoverAction(inv(row({ kind: "pane", state: "none" }), row({ activeAgoSec: 30 })));
    expect(a?.label).toBe("Continue this conversation in Trantor");
  });

  it("seats never drive the action — a crew without an orchestrator still offers Start", () => {
    expect(takeoverAction(inv(row({ kind: "seat", pid: 7 })))?.label).toBe("Start the orchestrator here");
  });
});

describe("takeoverAction — two candidates", () => {
  it("picks the NEWEST and says so — never guesses silently", () => {
    const older = row({ sessionId: "older", activeAgoSec: 300 });
    const newer = row({ sessionId: "newer", activeAgoSec: 40 });
    const a = takeoverAction(inv(older, newer));
    expect(a?.enabled).toBe(true);
    expect(a?.why).toContain("last active 40s ago");
    expect(a?.why).toContain("newest of 2 conversations");
  });

  it("is order-independent — the newest wins however the rows arrive", () => {
    const a = takeoverAction(inv(row({ sessionId: "newer", activeAgoSec: 40 }), row({ sessionId: "older", activeAgoSec: 300 })));
    expect(a?.why).toContain("last active 40s ago");
  });

  it("keeps the newest's verdict even when the newest is mid-turn and the older is idle", () => {
    const a = takeoverAction(inv(
      row({ sessionId: "older", activeAgoSec: 300 }),
      row({ sessionId: "newer", activeAgoSec: 3 }),
    ));
    expect(a?.enabled).toBe(false);
    expect(a?.why).toContain("mid-turn");
    expect(a?.why).toContain("newest of 2");
  });
});

describe("newestTerminal", () => {
  it("returns the freshest transcript, nulls last", () => {
    const fresh = row({ sessionId: "fresh", activeAgoSec: 5 });
    const stale = row({ sessionId: "stale", activeAgoSec: 500 });
    const quiet = row({ sessionId: "quiet", activeAgoSec: null });
    expect(newestTerminal(inv(stale, quiet, fresh))?.sessionId).toBe("fresh");
    expect(newestTerminal(inv(fresh, quiet))?.sessionId).toBe("fresh");
  });

  it("returns null with no terminal row (and with no inventory at all)", () => {
    expect(newestTerminal(inv(row({ kind: "seat" })))).toBeNull();
    expect(newestTerminal(inv(row({ kind: "pane", state: "idle" })))).toBeNull();
    expect(newestTerminal(null)).toBeNull();
  });
});

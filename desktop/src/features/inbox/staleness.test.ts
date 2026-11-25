// A newer message, closed work, or an old question with no open card makes a message stale.
// Sender liveness stays a deliberate non-signal: offline is not the same as gone.
import { describe, expect, it } from "vitest";
import { STALE_QUESTION_MS, stalenessOf } from "./staleness";
import type { Card, Message, Peer } from "../../shared/api/client";

const NOW = Date.now();
const msg = (over: Partial<Message> = {}): Message =>
  ({ id: 1, ts: NOW, from: "seat:trantor", to: "me:trantor", text: "?", ...over });

const card = (id: number, status: string): Card =>
  ({ id, project: "trantor", title: `card ${id}`, status });

describe("stalenessOf", () => {
  it("a newer message from the same sender supersedes the older one", () => {
    const older = msg({ id: 10 });
    const newer = msg({ id: 11 });
    expect(stalenessOf(older, [older, newer], [], []))
      .toEqual({ stale: true, reason: "seat:trantor asked again since" });
  });

  it("…but the newer message itself is not superseded", () => {
    const older = msg({ id: 10 });
    const newer = msg({ id: 11 });
    expect(stalenessOf(newer, [older, newer], [], []).stale).toBe(false);
  });

  it("a newer message from a DIFFERENT sender supersedes nothing", () => {
    const m = msg({ id: 10 });
    const other = msg({ id: 11, from: "other:trantor" });
    expect(stalenessOf(m, [m, other], [], []).stale).toBe(false);
  });

  it("the work is over when EVERY cited card is closed", () => {
    const m = msg({ refs: [100, 101] });
    const cards = [card(100, "done"), card(101, "failed")];
    expect(stalenessOf(m, [m], [], cards))
      .toEqual({ stale: true, reason: "#100, #101 are done" });
  });

  it("stale and cancelled count as closed too, not just done and failed", () => {
    expect(stalenessOf(msg({ refs: [100] }), [], [], [card(100, "stale")]).stale).toBe(true);
    expect(stalenessOf(msg({ refs: [100] }), [], [], [card(100, "cancelled")]).stale).toBe(true);
  });

  it("a single OPEN cited card keeps the thread live", () => {
    const m = msg({ refs: [100, 101] });
    const cards = [card(100, "done"), card(101, "doing")];
    expect(stalenessOf(m, [m], [], cards).stale).toBe(false);
  });

  it("a cited card the hub no longer serves keeps the thread live (missing ≠ closed)", () => {
    const m = msg({ refs: [100, 999] });
    expect(stalenessOf(m, [m], [], [card(100, "done")]).stale).toBe(false);
  });

  it("a nine-hour-old unanswered question still matters", () => {
    const m = msg({ ts: NOW - 9 * 60 * 60 * 1000 });
    expect(stalenessOf(m, [m], [], [], NOW).stale).toBe(false);
  });

  it("a 26-day-old question with no open card is stale, whatever other messages the view has", () => {
    const m = msg({ ts: NOW - 26 * 86_400_000 });
    const other = msg({ id: 99, from: "other:trantor" });
    const expected = { stale: true, reason: "asked 26d ago; no open card" } as const;
    expect(stalenessOf(m, [m], [], [], NOW)).toEqual(expected);
    expect(stalenessOf(m, [m, other], [], [], NOW)).toEqual(expected);
  });

  it("an open cited card keeps an old question live", () => {
    const m = msg({ ts: NOW - 26 * 86_400_000, refs: [100] });
    expect(stalenessOf(m, [m], [], [card(100, "doing")], NOW).stale).toBe(false);
  });

  it("age becomes stale only AFTER seven days without an open card", () => {
    const boundary = msg({ ts: NOW - STALE_QUESTION_MS });
    const old = msg({ ts: NOW - STALE_QUESTION_MS - 1 });
    expect(stalenessOf(boundary, [boundary], [], [], NOW).stale).toBe(false);
    expect(stalenessOf(old, [old], [], [], NOW)).toEqual({ stale: true, reason: "asked 7d ago; no open card" });
  });

  it("sender liveness is not a signal — an offline sender's recent question still matters", () => {
    const peers: Peer[] = [{ session: "seat:trantor", online: false, lastSeen: 0 }];
    const m = msg({ from: "seat:trantor" });
    expect(stalenessOf(m, [m], peers, [], NOW).stale).toBe(false);
  });
});

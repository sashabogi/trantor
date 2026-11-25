// Staleness is computed from the WORK, and only the work: a newer message from the same seat, or
// every cited card closed. These tests pin the rules AND the two deliberate non-rules — age and
// sender liveness — because both were tried, both were wrong, and both will be proposed again.
import { describe, expect, it } from "vitest";
import { stalenessOf } from "./staleness";
import type { Card, Message, Peer } from "../../shared/api/client";

const msg = (over: Partial<Message> = {}): Message =>
  ({ id: 1, ts: 0, from: "seat:trantor", to: "me:trantor", text: "?", ...over });

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

  it("age is never a staleness signal — a nine-hour-old unanswered question still matters", () => {
    const m = msg({ ts: Date.now() - 9 * 60 * 60 * 1000 });
    expect(stalenessOf(m, [m], [], []).stale).toBe(false);
  });

  it("sender liveness is not a signal — an offline sender's question still matters", () => {
    const peers: Peer[] = [{ session: "seat:trantor", online: false, lastSeen: 0 }];
    const m = msg({ from: "seat:trantor" });
    expect(stalenessOf(m, [m], peers, []).stale).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { activityRank, computeProjectActivity, isWorkingStatus, needsYou } from "./projectActivity";
import type { LocalSession, Peer } from "../shared/api/client";

describe("computeProjectActivity", () => {
  it("counts a herdr-visible pane with no hub heartbeat as open/active (#6163)", () => {
    // pr-os's orch pane herdr already names an agent for — status "working" — but the pane just
    // woke up and has not run a tool yet, so no hub peer exists for it at all.
    const open: LocalSession[] = [{ project: "pr-os", status: "working" }];
    const peers: Peer[] = [];

    const activity = computeProjectActivity(open, peers);

    expect(activity.has("pr-os")).toBe(true);
    expect(activity.get("pr-os")).toEqual({ kind: "open", status: "working" });
    // and it must sort into ACTIVE NOW's top tier, same as a busy row
    expect(activityRank(activity.get("pr-os"))).toBe(0);
  });

  it("never drops the project once its one heartbeat ages past the 90s busy window", () => {
    // Before the fix: activity was seeded ONLY from hub peers plus a bare local_sessions()
    // string list carrying no status, so once the single heartbeat this pane ever sent aged out
    // there was nothing left naming pr-os as open at all.
    const open: LocalSession[] = [{ project: "pr-os", status: "idle" }];
    const peers: Peer[] = []; // heartbeat long gone

    const activity = computeProjectActivity(open, peers);

    expect(activity.get("pr-os")).toEqual({ kind: "open", status: "idle" });
  });

  it("keeps a process-truth-only project open with no status", () => {
    const open: LocalSession[] = [{ project: "crebral-health", status: null }];
    const activity = computeProjectActivity(open, []);
    expect(activity.get("crebral-health")).toEqual({ kind: "open", status: null });
  });

  it("upgrades an open project to busy when a fresher hub heartbeat exists", () => {
    const open: LocalSession[] = [{ project: "trantor", status: "idle" }];
    const peers: Peer[] = [
      { session: "sasha@mac", project: "trantor", lastSeen: Date.now(), status: "working · edit" },
    ];
    const activity = computeProjectActivity(open, peers);
    expect(activity.get("trantor")?.kind).toBe("busy");
  });

  it("dedupes peers across multiple hub URLs, keeping the freshest per session", () => {
    const now = Date.now();
    const peers: Peer[] = [
      { session: "sasha@mac", project: "trantor", lastSeen: now - 5_000 },
      { session: "sasha@mac", project: "trantor", lastSeen: now },
    ];
    const activity = computeProjectActivity([], peers);
    expect(activity.get("trantor")).toMatchObject({ kind: "busy", lastSeen: now });
  });

  it("ignores a peer that is neither hub-busy nor recently seen", () => {
    const peers: Peer[] = [
      { session: "sasha@mac", project: "trantor", lastSeen: Date.now() - 10 * 60 * 1000, status: "idle" },
    ];
    const activity = computeProjectActivity([], peers);
    expect(activity.has("trantor")).toBe(false);
  });
});

describe("isWorkingStatus", () => {
  it("is true only for 'working', case-insensitively", () => {
    expect(isWorkingStatus("working")).toBe(true);
    expect(isWorkingStatus("WORKING")).toBe(true);
    expect(isWorkingStatus("idle")).toBe(false);
    expect(isWorkingStatus(null)).toBe(false);
    expect(isWorkingStatus(undefined)).toBe(false);
  });
});

describe("needsYou (#6094)", () => {
  it("is true only for 'blocked', case-insensitively", () => {
    expect(needsYou("blocked")).toBe(true);
    expect(needsYou("BLOCKED")).toBe(true);
    expect(needsYou(" blocked ")).toBe(true);
    expect(needsYou("working")).toBe(false);
    expect(needsYou("idle")).toBe(false);
    expect(needsYou("done")).toBe(false);
    expect(needsYou(null)).toBe(false);
    expect(needsYou(undefined)).toBe(false);
  });
});

describe("activityRank", () => {
  it("ranks busy and open-working first, everything else after", () => {
    expect(activityRank({ kind: "busy" })).toBe(0);
    expect(activityRank({ kind: "open", status: "working" })).toBe(0);
    expect(activityRank({ kind: "open", status: "idle" })).toBe(1);
    expect(activityRank({ kind: "open", status: null })).toBe(1);
    expect(activityRank(undefined)).toBe(1);
  });
});

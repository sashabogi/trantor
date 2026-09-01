import { describe, expect, it } from "vitest";
import { dutyActions, episodeCards, escalationLedger, policyProjects, quietEvidence } from "./model";
import type { HubEvent, OverseerStatus, Peer } from "../../shared/api/client";

const status = (s: Partial<OverseerStatus>): OverseerStatus => ({
  engine: true,
  lastTickTs: 1_000_000,
  tickMs: 30_000,
  clearMs: 120_000,
  dutySession: "claude:trantor-duty",
  watching: { sessions: 0, projects: 0, claims: 0, links: 0 },
  autonomy: { "*": 1 },
  links: [],
  warnings: [],
  standing: 0,
  ...s,
});

describe("episodeCards", () => {
  it("collapses repeated warnings into one episode with accrued duration", () => {
    const events: HubEvent[] = [
      { ts: 900_000, type: "overseer.warn", project: "trantor", kind: "file-conflict", detail: "same file", files: ["a.ts"], sessions: ["a", "b"] },
      { ts: 950_000, type: "overseer.warn", project: "trantor", kind: "file-conflict", detail: "same file", files: ["a.ts"], sessions: ["b", "a"] },
    ];
    const eps = episodeCards(status({
      warnings: [{ project: "trantor", kind: "file-conflict", detail: "same file", files: ["a.ts"], sessions: ["a", "b"], since: 880_000 }],
    }), events);
    expect(eps).toHaveLength(1);
    expect(eps[0]).toMatchObject({ count: 3, first: 880_000, last: 1_000_000, open: true });
  });
});

describe("quietEvidence", () => {
  it("cites the sweep age, seats, and file claims instead of saying nothing is wrong", () => {
    const now = Date.now();
    const peers: Peer[] = [
      { session: "a", lastSeen: now - 15_000 },
      { session: "b", lastSeen: now - 210_000 },
    ];
    expect(quietEvidence(status({ lastTickTs: now - 10_000, watching: { sessions: 2, projects: 1, claims: 1, links: 0 } }), peers, now))
      .toBe("presence swept 10s ago, all 2 known seats heartbeating, 1 file claim watched");
  });
});

describe("duty and escalation rows", () => {
  it("keeps duty actions separate from the escalation ledger", () => {
    const events: HubEvent[] = [
      { ts: 3, type: "message", by: "hub:duty", text: "patrol complete" },
      { ts: 2, type: "message", by: "hub:duty", text: "UNDELIVERED for 12m" },
      { ts: 1, type: "message", by: "agent:x", text: "ordinary" },
    ];
    expect(dutyActions(events, "claude:trantor-duty").map(e => e.ts)).toEqual([3, 2]);
    expect(escalationLedger(events).map(e => e.ts)).toEqual([2]);
  });
});

describe("policyProjects", () => {
  it("uses explicit autonomy rows, links, and live warnings", () => {
    const got = policyProjects(status({
      autonomy: { "*": 1, trantor: 2 },
      links: [{ projects: ["crebral-health", "crebral-scribe"], reason: "shared schema" }],
      warnings: [{ project: "teams", kind: "same-project-sessions", sessions: [], files: [], detail: "two seats" }],
    }));
    expect(got).toEqual(["crebral-health", "crebral-scribe", "teams", "trantor"]);
  });
});

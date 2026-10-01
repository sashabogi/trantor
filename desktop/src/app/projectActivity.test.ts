import { describe, expect, it } from "vitest";
import {
  activityLine, activityRank, activityTitle, computeProjectActivity,
  isWorkingStatus, needsYou, sortByRecency, wakeIsReal,
} from "./projectActivity";
import type { ProjectActivity } from "./projectActivity";
import type { LocalSession, Peer } from "../shared/api/client";
import { ONLINE_MS } from "../shared/presence";

const NOW = 1_700_000_000_000;

describe("computeProjectActivity — mid-turn is a report, not a heartbeat (#7775)", () => {
  it("does NOT call a project mid-turn just because its heartbeat is inside the 90s window", () => {
    // The bug, exactly: ten projects reading "mid-turn" at once because each had touched the hub
    // recently. The runner says it is idle; recency of the heartbeat must not overrule that.
    const peers: Peer[] = [
      { session: "sasha@mac", project: "trantor", lastSeen: NOW - 5_000, status: "idle" },
    ];
    const act = computeProjectActivity([], peers, NOW);
    expect(act.get("trantor")?.state).toBe("idle");
    expect(activityLine(act.get("trantor"), NOW)?.text).toBe("idle");
  });

  it("reads working from the runner's own hub status, carrying its heartbeat and model", () => {
    const peers: Peer[] = [
      { session: "glm:trantor", project: "trantor", lastSeen: NOW - 5_000, status: "working · edit", model: "glm-5.3" },
    ];
    const act = computeProjectActivity([], peers, NOW);
    expect(act.get("trantor")).toMatchObject({ state: "working", lastSeen: NOW - 5_000, model: "glm-5.3" });
    expect(activityLine(act.get("trantor"), NOW)?.text).toBe("mid-turn · 5s ago · glm-5.3");
  });

  it("reads working from herdr's agent_status for a pane with no heartbeat yet (#6163)", () => {
    const open: LocalSession[] = [{ project: "pr-os", status: "working" }];
    expect(computeProjectActivity(open, [], NOW).get("pr-os")?.state).toBe("working");
  });

  it("treats herdr's 'busy' as a turn in flight, same as livenessHold does", () => {
    const open: LocalSession[] = [{ project: "pr-os", status: "busy" }];
    expect(computeProjectActivity(open, [], NOW).get("pr-os")?.state).toBe("working");
  });

  it("says UNKNOWN when process truth is the only evidence and nothing reports a status", () => {
    // Absence of evidence is reported, never guessed at — the rule livenessHold applies to a pane
    // with no transcript on disk.
    const open: LocalSession[] = [{ project: "crebral-health", status: null }];
    const act = computeProjectActivity(open, [], NOW);
    expect(act.get("crebral-health")?.state).toBe("unknown");
    expect(activityLine(act.get("crebral-health"), NOW)?.text).toBe("status unknown");
  });

  it("keeps the project listed once its heartbeat ages past the 90s window", () => {
    const open: LocalSession[] = [{ project: "pr-os", status: "idle" }];
    expect(computeProjectActivity(open, [], NOW).get("pr-os")?.state).toBe("idle");
  });

  it("drops a peer the hub no longer considers online — a stale status is a memory, not a report", () => {
    const peers: Peer[] = [
      { session: "sasha@mac", project: "trantor", lastSeen: NOW - ONLINE_MS - 1, status: "working · edit" },
    ];
    expect(computeProjectActivity([], peers, NOW).has("trantor")).toBe(false);
  });

  it("drops a peer explicitly marked offline even with a fresh lastSeen", () => {
    const peers: Peer[] = [
      { session: "sasha@mac", project: "trantor", lastSeen: NOW, status: "working · edit", online: false },
    ];
    expect(computeProjectActivity([], peers, NOW).has("trantor")).toBe(false);
  });

  it("dedupes peers across multiple hub URLs, keeping the freshest per session", () => {
    const peers: Peer[] = [
      { session: "sasha@mac", project: "trantor", lastSeen: NOW - 60_000, status: "working · edit" },
      { session: "sasha@mac", project: "trantor", lastSeen: NOW, status: "idle" },
    ];
    // the freshest row for that session says idle, so the stale "working" must not win
    expect(computeProjectActivity([], peers, NOW).get("trantor")?.state).toBe("idle");
  });

  it("lets a working peer upgrade a project herdr only knows as idle", () => {
    const open: LocalSession[] = [{ project: "trantor", status: "idle" }];
    const peers: Peer[] = [
      { session: "glm:trantor", project: "trantor", lastSeen: NOW, status: "working · edit" },
    ];
    expect(computeProjectActivity(open, peers, NOW).get("trantor")?.state).toBe("working");
  });

  it("never lets an idle peer downgrade a project herdr reports working", () => {
    const open: LocalSession[] = [{ project: "trantor", status: "working" }];
    const peers: Peer[] = [
      { session: "sasha@mac", project: "trantor", lastSeen: NOW, status: "idle" },
    ];
    expect(computeProjectActivity(open, peers, NOW).get("trantor")?.state).toBe("working");
  });
});

describe("needs-you no longer depends on herdr alone (#7775 item 3)", () => {
  it("reads blocked off the runner's hub status, which herdr's screen detection misses", () => {
    const peers: Peer[] = [
      { session: "kimi:trantor", project: "trantor", lastSeen: NOW, status: "blocked: waiting on an answer" },
    ];
    const act = computeProjectActivity([], peers, NOW);
    expect(act.get("trantor")?.state).toBe("needs-you");
    expect(activityLine(act.get("trantor"), NOW)).toEqual({ text: "needs you", tone: "warn" });
  });

  it("still reads blocked off herdr when herdr is the one that saw it", () => {
    const open: LocalSession[] = [{ project: "pr-os", status: "blocked" }];
    expect(computeProjectActivity(open, [], NOW).get("pr-os")?.state).toBe("needs-you");
  });

  it("sorts a blocked project above a working one, so it is visible without clicking", () => {
    const act = computeProjectActivity([], [
      { session: "a:x", project: "busy-proj", lastSeen: NOW, status: "working · edit" },
      { session: "b:y", project: "stuck-proj", lastSeen: NOW, status: "blocked: needs an answer" },
    ], NOW);
    const order = ["busy-proj", "stuck-proj"].sort((a, b) => activityRank(act.get(a)) - activityRank(act.get(b)));
    expect(order[0]).toBe("stuck-proj");
  });
});

describe("wakeIsReal (#7775 item 1)", () => {
  it("offers Wake where waking does something: an idle row, and a project with no session", () => {
    expect(wakeIsReal({ state: "idle", evidence: "" })).toBe(true);
    expect(wakeIsReal({ state: "needs-you", evidence: "" })).toBe(true);
    expect(wakeIsReal(undefined)).toBe(true);
  });

  it("withholds Wake from a row mid-turn and from one whose state is unknown", () => {
    expect(wakeIsReal({ state: "working", evidence: "" })).toBe(false);
    expect(wakeIsReal({ state: "unknown", evidence: "" })).toBe(false);
  });
});

describe("activityTitle (#7775 item 4)", () => {
  it("prints the evidence itself, so the tooltip asserts nothing extra", () => {
    const act = computeProjectActivity([], [
      { session: "sasha@mac", project: "trantor", lastSeen: NOW, status: "idle" },
    ], NOW);
    expect(activityTitle(act.get("trantor"))).toBe("a session is here and nothing reports a turn executing");
    expect(activityTitle(undefined)).toBeUndefined();
  });

  it("an unknown row's tooltip says it does not know, rather than claiming idle", () => {
    const act = computeProjectActivity([{ project: "crebral-health", status: null }], [], NOW);
    expect(activityTitle(act.get("crebral-health")))
      .toBe("a session process is here; nothing reports what it is doing");
  });
});

describe("activityRank", () => {
  it("ranks needs-you, then working, then idle, then unknown", () => {
    expect(activityRank({ state: "needs-you", evidence: "" })).toBe(0);
    expect(activityRank({ state: "working", evidence: "" })).toBe(1);
    expect(activityRank({ state: "idle", evidence: "" })).toBe(2);
    expect(activityRank({ state: "unknown", evidence: "" })).toBe(3);
    expect(activityRank(undefined)).toBe(3);
  });
});

describe("sortByRecency (#9813 — the ACTIVE NOW tie-break is recency, never the name)", () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;

  const idleMap = (names: string[]): Map<string, ProjectActivity> =>
    new Map(names.map(n => [n, { state: "idle" as const, evidence: "idle" }]));

  it("orders three idle projects newest-turn first, where alphabetical order would differ", () => {
    // Alphabetically this list reads asteroids, css, trantor — the bug: trantor, worked on
    // minutes ago, sank beneath a week-idle project the moment its turn ended.
    const names = ["css", "trantor", "asteroids"];
    const activity = idleMap(names);
    const lastTurn = new Map([
      ["trantor", NOW - 3 * 60_000],
      ["asteroids", NOW - 2 * HOUR],
      ["css", NOW - 5 * DAY],
    ]);
    expect(sortByRecency(names, activity, lastTurn)).toEqual(["trantor", "asteroids", "css"]);
  });

  it("keeps rank above recency: an hours-old needs-you row still tops a just-worked idle one", () => {
    const names = ["zeta", "alpha"];
    const activity = new Map<string, ProjectActivity>([
      ["zeta", { state: "idle", evidence: "" }],
      ["alpha", { state: "needs-you", evidence: "" }],
    ]);
    const lastTurn = new Map([
      ["zeta", NOW - 1_000],
      ["alpha", NOW - 6 * HOUR],
    ]);
    expect(sortByRecency(names, activity, lastTurn)).toEqual(["alpha", "zeta"]);
  });

  it("sorts a project with no transcript stamp after timestamped siblings in its rank", () => {
    // No evidence cannot out-rank evidence: an unknown age goes last even when its name is
    // alphabetically first, so a fresh row is never pushed down by a blank.
    const names = ["aaa", "mmm", "zzz"];
    const activity = idleMap(names);
    const lastTurn = new Map([
      ["zzz", NOW - 30_000],
      ["mmm", NOW - HOUR],
    ]);
    expect(sortByRecency(names, activity, lastTurn)).toEqual(["zzz", "mmm", "aaa"]);
  });

  it("breaks equal stamps by name so the order never flickers between renders", () => {
    const names = ["bravo", "alpha"];
    const activity = idleMap(names);
    const t = NOW - HOUR;
    const lastTurn = new Map([["alpha", t], ["bravo", t]]);
    expect(sortByRecency(names, activity, lastTurn)).toEqual(["alpha", "bravo"]);
  });

  it("does not mutate the caller's array", () => {
    const names = ["css", "trantor"];
    const activity = idleMap(names);
    const lastTurn = new Map([["trantor", NOW], ["css", NOW - 1]]);
    sortByRecency(names, activity, lastTurn);
    expect(names).toEqual(["css", "trantor"]);
  });
});

describe("isWorkingStatus", () => {
  it("is true only for 'working', case-insensitively", () => {
    expect(isWorkingStatus("working")).toBe(true);
    expect(isWorkingStatus("WORKING")).toBe(true);
    expect(isWorkingStatus("idle")).toBe(false);
    expect(isWorkingStatus(null)).toBe(false);
  });
});

describe("needsYou", () => {
  it("is true for herdr's bare 'blocked' and the runner's 'blocked: <reason>'", () => {
    expect(needsYou("blocked")).toBe(true);
    expect(needsYou("BLOCKED")).toBe(true);
    expect(needsYou(" blocked ")).toBe(true);
    expect(needsYou("blocked: waiting on an answer")).toBe(true);
    expect(needsYou("working")).toBe(false);
    expect(needsYou("idle")).toBe(false);
    expect(needsYou(null)).toBe(false);
  });
});

describe("background sub-agents read working (#10007)", () => {
  it("an orchestrator whose turn ENDED reads working while its sub-agents still run", () => {
    // The live case that opened the card: herdr pane says "done", the manifest still owes two
    // completions — the row must not say idle while background work is running.
    const open: LocalSession[] = [{ project: "ibkr", status: "done", inFlight: 2 }];
    const act = computeProjectActivity(open, [], NOW);
    expect(act.get("ibkr")?.state).toBe("working");
    expect(activityLine(act.get("ibkr"), NOW)?.text).toBe("working · 2 sub-agents");
    expect(activityTitle(act.get("ibkr"))).toBe("2 background sub-agents running");
  });

  it("one sub-agent reads singular", () => {
    const open: LocalSession[] = [{ project: "ibkr", status: "done", inFlight: 1 }];
    const act = computeProjectActivity(open, [], NOW);
    expect(activityLine(act.get("ibkr"), NOW)?.text).toBe("working · 1 sub-agent");
    expect(activityTitle(act.get("ibkr"))).toBe("1 background sub-agent running");
  });

  it("inFlight 0 claims nothing: herdr's 'done' stays idle", () => {
    const open: LocalSession[] = [{ project: "ibkr", status: "done", inFlight: 0 }];
    const act = computeProjectActivity(open, [], NOW);
    expect(act.get("ibkr")?.state).toBe("idle");
    expect(activityLine(act.get("ibkr"), NOW)?.text).toBe("idle");
  });

  it("a null inFlight claims nothing — no manifest evidence, no working", () => {
    const open: LocalSession[] = [{ project: "ibkr", status: "idle", inFlight: null }];
    expect(computeProjectActivity(open, [], NOW).get("ibkr")?.state).toBe("idle");
  });

  it("a real mid-turn outranks the sub-agent signal: herdr's working keeps the row", () => {
    const open: LocalSession[] = [{ project: "ibkr", status: "working", inFlight: 3 }];
    const act = computeProjectActivity(open, [], NOW);
    expect(act.get("ibkr")?.state).toBe("working");
    expect(act.get("ibkr")?.subagents).toBeUndefined();
    expect(activityLine(act.get("ibkr"), NOW)?.text).toBe("mid-turn");
  });

  it("a blocked pane still reads needs-you even with sub-agents in flight", () => {
    const open: LocalSession[] = [{ project: "ibkr", status: "blocked", inFlight: 1 }];
    const act = computeProjectActivity(open, [], NOW);
    expect(act.get("ibkr")?.state).toBe("needs-you");
    expect(activityLine(act.get("ibkr"), NOW)?.text).toBe("needs you");
  });
});

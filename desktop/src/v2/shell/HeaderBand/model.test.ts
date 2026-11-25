import { expect, it } from "vitest";
import { hold, phase, proposal, turn } from "./testFixtures";
import type { Peer } from "../../../shared/api/client";
import { phaseProgress } from "./PhaseGoal";
import { barPlacement, laneRows, turnColor } from "./SeatLanes";
import { ciPollDelay, pendingIds } from "./useBandData";

it("chooses current work by status and newest card activity across both groups", () => {
  const old = phase("stabilize", ["todo"]);
  old.crew[0].ts = 900;
  const live = phase("live", ["doing", "done"], "Ship the header");
  live.crew[0].ts = 100;
  live.crew[0].updated = 800;
  const stale = phase("stale", ["doing"]);
  stale.crew[0].ts = 200;
  expect(phaseProgress([live, stale, old])).toMatchObject({ goal: "Ship the header", done: 1, total: 2, fraction: 0.5 });
  stale.crew[0].updated = 1000;
  expect(phaseProgress([live, stale, old])?.goal).toBe("stale");
  stale.crew[0].status = "done";
  live.crew[0].status = "testing";
  expect(phaseProgress([live, stale, old])?.goal).toBe("Ship the header");
  live.crew[0].status = "done";
  expect(phaseProgress([live, stale, old])?.goal).toBe("stabilize");
  old.orchestrators.push({ id: 20, title: "Review", status: "doing", updated: 10 });
  expect(phaseProgress([live, old, stale])?.goal).toBe("stabilize");
});

it("uses creation stamps for new cards and the most recent completed phase when nothing is open", () => {
  const recent = phase("recent", ["todo"]);
  recent.crew[0].ts = 200;
  const old = phase("old", ["todo"]);
  old.crew[0].ts = 100;
  expect(phaseProgress([recent, old])?.goal).toBe("recent");
  recent.crew[0].status = "done"; old.crew[0].status = "done";
  expect(phaseProgress([recent, old])).toMatchObject({ goal: "recent", done: 1, total: 1, fraction: 1, open: [] });
  expect(phaseProgress([phase("empty", [])])).toBeNull();
  expect(phaseProgress([phase("P1", ["todo", "doing", "blocked", "todo"])])?.open).toHaveLength(3);
});

it("places and clips turn bars on a 60 minute scale", () => {
  expect(barPlacement(900_000, 1_800_000, 3_600_000)).toEqual({ left: "25%", width: "25%" });
  expect(barPlacement(-300_000, 900_000, 3_600_000)).toEqual({ left: "0%", width: "25%" });
  expect(barPlacement(2_700_000, 4_000_000, 3_600_000)).toEqual({ left: "75%", width: "25%" });
  expect(barPlacement(-2, -1, 3_600_000).width).toBe("0%");
});

it("colours good turns green, bad turns red and unknown turns quietly", () => {
  expect(turnColor(turn())).toBe("var(--v2-ok-edge)");
  for (const outcome of ["cut", "stalled", "authFailed"]) expect(turnColor(turn({ outcome }))).toBe("var(--v2-bad)");
  for (const flags of [{ cut: true }, { stalled: true }, { authFailed: true }, { effExit: 2 }]) {
    expect(turnColor(turn(flags))).toBe("var(--v2-bad)");
  }
  expect(turnColor(turn({ effExit: null }))).toBe("var(--v2-track)");
});

it("groups by persona and prioritizes working project seats, capped at three", () => {
  const peers: Peer[] = ["a", "b", "c", "d", "z"].map(name => ({ session: `${name}:trantor`, online: true, status: name === "z" ? "working · card" : "idle" }));
  peers.push({ session: "outsider:other", online: true, status: "working" });
  const rows = laneRows(peers, [turn({ persona: "z" }), turn({ id: "t2", persona: "z", ts: 3_100_000 }), turn({ project: "other" })], "trantor", 3_600_000);
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatchObject({ persona: "z", status: "working", lastEnd: 3_100_000 });
  expect(rows[0].rows).toHaveLength(2);
  expect(rows.some(row => row.persona === "outsider")).toBe(false);
  expect(laneRows([], [turn()], "trantor", 3_600_000)[0].status).toBe("offline");
  expect(laneRows([{ session: "codex-8:trantor", online: false, status: "working" }], [], "trantor", 3_600_000)).toEqual([]);
});

it("counts pending decisions for this project with separate id namespaces", () => {
  expect(pendingIds("trantor", [proposal(1), proposal(2, "other"), { ...proposal(3), status: "approved" }],
    [hold(1), hold(2, "other"), { ...hold(3), status: "go" }])).toEqual(["proposal:1", "hold:1"]);
});

it("polls running CI every minute and settled or unavailable CI every five minutes", () => {
  expect(ciPollDelay({ sha: "a", tag: null, hasRemote: true, localCheckout: true, tagPublishedAt: null, ci: { state: "running" } })).toBe(60_000);
  for (const state of ["green", "red", null] as const) expect(ciPollDelay({ sha: "a", tag: null, hasRemote: true, localCheckout: true, tagPublishedAt: null, ci: { state } })).toBe(300_000);
  expect(ciPollDelay(null)).toBe(300_000);
});

it("includes the orchestrator from presence and ranks recent turns ahead of idle seats", () => {
  const peers: Peer[] = [
    { session: "MacBook:trantor", online: true, status: "working" },
    { session: "a:trantor", online: true, status: "idle" },
    { session: "z:trantor", online: false },
    { session: "old:trantor", online: false },
  ];
  const rows = laneRows(peers, [turn({ persona: "z" }), turn({ persona: "old", ts: -1 })], "trantor", 3_600_000);
  expect(rows.map(r => r.persona)).toEqual(["orchestrator", "z", "a"]);
  expect(rows[0]).toMatchObject({ status: "working", rows: [], lastEnd: null });
  expect(laneRows(peers, [], "trantor", 7_200_000).map(r => r.persona)).toEqual(["orchestrator", "a"]);
});

import { expect, it } from "vitest";
import { hold, phase, proposal, turn } from "./testFixtures";
import type { Peer } from "../../../shared/api/client";
import { phaseProgress } from "./PhaseGoal";
import { barPlacement, laneRows, turnColor } from "./SeatLanes";
import { ciPollDelay, pendingIds } from "./useBandData";

it("chooses the last unfinished phase and counts both card groups", () => {
  const selected = phase("P2", ["done", "todo"], "Ship the header");
  selected.orchestrators.push({ id: 20, title: "Review", status: "done" });
  expect(phaseProgress([phase("P1", ["todo"]), selected, phase("P3", ["done"])])).toMatchObject({
    goal: "Ship the header", done: 2, total: 3, fraction: 2 / 3, open: [{ id: 1, title: "Card 1", status: "todo" }],
  });
  expect(phaseProgress([phase("P1", ["done"]), phase("P2", ["done"])])).toMatchObject({ goal: "P2", fraction: 1 });
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

it("groups by persona and prioritizes working project seats, capped at four", () => {
  const peers: Peer[] = ["a", "b", "c", "d", "z"].map(name => ({ session: `${name}:trantor`, online: true, status: name === "z" ? "working · card" : "idle" }));
  peers.push({ session: "outsider:other", online: true, status: "working" });
  const rows = laneRows(peers, [turn({ persona: "z" }), turn({ id: "t2", persona: "z", ts: 3_100_000 }), turn({ project: "other" })], "trantor");
  expect(rows).toHaveLength(4);
  expect(rows[0]).toMatchObject({ persona: "z", status: "working", lastEnd: 3_100_000 });
  expect(rows[0].rows).toHaveLength(2);
  expect(rows.some(row => row.persona === "outsider")).toBe(false);
  expect(laneRows([], [turn()], "trantor")[0].status).toBe("offline");
  expect(laneRows([{ session: "codex-8:trantor", online: false, status: "working" }], [], "trantor")[0].status).toBe("offline");
});

it("counts pending decisions for this project with separate id namespaces", () => {
  expect(pendingIds("trantor", [proposal(1), proposal(2, "other"), { ...proposal(3), status: "approved" }],
    [hold(1), hold(2, "other"), { ...hold(3), status: "go" }])).toEqual(["proposal:1", "hold:1"]);
});

it("polls running CI every minute and settled or unavailable CI every five minutes", () => {
  expect(ciPollDelay({ sha: "a", tag: null, ci: { state: "running" } })).toBe(60_000);
  for (const state of ["green", "red", null] as const) expect(ciPollDelay({ sha: "a", tag: null, ci: { state } })).toBe(300_000);
  expect(ciPollDelay(null)).toBe(300_000);
});

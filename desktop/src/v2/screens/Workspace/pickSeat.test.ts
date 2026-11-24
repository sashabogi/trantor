// @vitest-environment happy-dom
// #13987 drill: the Workspace opened on codex instead of the orchestrator.
import { describe, expect, it } from "vitest";
import { pickSeat } from "./index";
import type { SeatView } from "./seatModel";

const seat = (key: string, isOrchestrator: boolean): SeatView => {
  const base = { key, label: key, agent: key, brand: key, session: `${key}:trantor` };
  return { ...base, presence: "ready", words: "ready", isOrchestrator, target: { ...base, online: true, isOrchestrator } };
};

describe("pickSeat", () => {
  const seats = [seat("codex-8", false), seat("orchestrator", true), seat("kimi-9", false)];

  it("lands on the orchestrator when nothing was chosen", () => {
    expect(pickSeat(seats, null)?.key).toBe("orchestrator");
  });

  it("keeps the operator's choice", () => {
    expect(pickSeat(seats, "kimi-9")?.key).toBe("kimi-9");
  });

  it("falls back to a live crew seat when no orchestrator is hosted", () => {
    expect(pickSeat([seat("codex-8", false)], null)?.key).toBe("codex-8");
  });
});

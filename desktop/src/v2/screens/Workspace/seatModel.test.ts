// #14365: what the hub status of a seat that cannot work becomes in the seat view.
import { describe, expect, it } from "vitest";
import { benchedWords, seatViews } from "./seatModel";
import type { PaneTarget } from "../../../features/workspace/paneTargets";

const target = (status: string): PaneTarget => ({ key: "codex-8:trantor", label: "codex-8", agent: "codex-8", brand: "codex", session: "codex-8:trantor", online: true, status, isOrchestrator: false });

describe("benched seats in the seat view", () => {
  it("keeps a parked runner's own words instead of 'ready'", () => {
    expect(benchedWords("parked (exhausted)")).toBe("parked (exhausted)");
    expect(benchedWords("stalled · no activity")).toBe("stalled · no activity");
    expect(benchedWords("idle")).toBeNull();
    const [seat] = seatViews([target("parked (exhausted)")], []);
    expect(seat.presence).toBe("ready");
    expect(seat.words).toBe("parked (exhausted)");
    expect(seatViews([target("idle")], [])[0].words).toBe("ready");
  });
});

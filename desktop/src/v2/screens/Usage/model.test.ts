// #13991: range filtering and per-agent/vendor aggregation read the hub's real series shapes.
import { describe, expect, it } from "vitest";
import type { Economics } from "../../../shared/api/client";
import {
  agentStats, barDays, dailyTurns, econFor, filterAgents, NO_FILTERS, rangeWindow, vendorOf, type SeriesAgent,
} from "./model";

const NOW = Date.parse("2026-11-24T15:00:00Z");
const agent = (name: string, points: [string, number, number][]): SeriesAgent => ({
  agent: name, turns: 0, failures: 0, failRate: 0, models: ["m"], lastFailure: null,
  series: { failRate: points.map(([day, turns, failures]) => ({ day, turns, failures })) },
});

describe("range windows", () => {
  it("Today is one UTC day, 7 days is seven, This month starts on the 1st, All time is open", () => {
    expect(rangeWindow("today", NOW)).toEqual({ start: "2026-11-24", end: "2026-11-24" });
    expect(rangeWindow("7d", NOW).start).toBe("2026-11-18");
    expect(rangeWindow("14d", NOW).start).toBe("2026-11-11");
    expect(rangeWindow("30d", NOW).start).toBe("2026-10-26");
    expect(rangeWindow("month", NOW).start).toBe("2026-11-01");
    expect(rangeWindow("all", NOW).start).toBeNull();
  });

  it("draws one bar per day, oldest first", () => {
    const days = barDays(rangeWindow("7d", NOW), null);
    expect(days).toHaveLength(7);
    expect(days[0]).toBe("2026-11-18");
    expect(days[6]).toBe("2026-11-24");
  });
});

describe("agent aggregation", () => {
  const agents = [
    agent("codex", [["2026-11-10", 5, 1], ["2026-11-20", 10, 2], ["2026-11-24", 4, 0]]),
    agent("glm", [["2026-11-24", 7, 3]]),
  ];

  it("sums only the days inside the range", () => {
    const week = agentStats(agents, rangeWindow("7d", NOW));
    expect(week.find(a => a.agent === "codex")).toMatchObject({ turns: 14, failures: 2 });
    const all = agentStats(agents, rangeWindow("all", NOW));
    expect(all.find(a => a.agent === "codex")?.turns).toBe(19);
    expect(agentStats(agents, rangeWindow("today", NOW)).map(a => a.agent)).toEqual(["glm", "codex"]);
  });

  it("splits daily turns by vendor and filters by vendor", () => {
    const w = rangeWindow("7d", NOW);
    const stats = agentStats(agents, w);
    const today = dailyTurns(stats, barDays(w, null)).find(b => b.day === "2026-11-24");
    expect(today?.byVendor).toMatchObject({ Codex: 4, GLM: 7 });
    expect(today?.total).toBe(11);
    expect(filterAgents(stats, { ...NO_FILTERS, vendor: "GLM" }).map(a => a.agent)).toEqual(["glm"]);
  });

  it("names vendors from agent and model strings", () => {
    expect(vendorOf("orchestrator")).toBe("Claude");
    expect(vendorOf("deepseek-v4-flash")).toBe("DeepSeek");
    expect(vendorOf("mystery")).toBe("Other");
  });
});

describe("economics windows", () => {
  const win = { calls: 3, tokens_in: 1000, tokens_out: 500, cost_usd: 1.25, opus_equiv_usd: 9, saved_usd: 7.75 };
  const econ: Economics = {
    windows: { week: win, lifetime: win },
    costKinds: { week: { "orchestrator-notional": { count: 2, usd: 40 }, crew: { count: 5, usd: null } } },
  };

  it("maps a range to the hub's rolling window and sums only notional kinds", () => {
    expect(econFor("7d", econ)).toMatchObject({ available: true, cost: 1.25, saved: 7.75, tokens: 1500, apiValue: 40 });
  });

  it("is unavailable where the hub serves no window, and API value is null without notional rows", () => {
    expect(econFor("14d", econ).available).toBe(false);
    expect(econFor("month", econ).available).toBe(false);
    expect(econFor("all", econ).apiValue).toBeNull();
    expect(econFor("7d", null).available).toBe(false);
  });
});

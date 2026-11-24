// #13991: plan cards never guess; no meter says so, forecasts need a known window.
import { describe, expect, it } from "vitest";
import type { BalanceRow } from "../../../features/fleet/balanceChips";
import { paceForecast, planCards } from "./plans";

const NOW = Date.parse("2026-11-24T12:00:00Z");
const base = { ok: true, low: false };

describe("pace forecast", () => {
  it("says the plan lasts when the rate so far stays under the limit", () => {
    const resetsAt = NOW + 3.5 * 86400e3;
    expect(paceForecast(30, resetsAt, "7d", NOW)).toBe("lasts past the reset at this pace");
  });

  it("names the time to the limit when the pace overshoots", () => {
    const resetsAt = NOW + 1 * 3600e3;
    expect(paceForecast(95, resetsAt, "5h", NOW)).toMatch(/^runs out in ~\d+m at this pace$/);
  });

  it("computes nothing without a known window or a reset", () => {
    expect(paceForecast(50, NOW + 1e6, "30d", NOW)).toBeNull();
    expect(paceForecast(50, null, "5h", NOW)).toBeNull();
  });
});

describe("plan cards", () => {
  const rows: BalanceRow[] = [
    { ...base, provider: "claude", label: "Claude", kind: "windows", plan: "Max",
      windows: [{ name: "5h", usedPct: 22, resetsAt: NOW + 3 * 3600e3 }, { name: "7d", usedPct: 14, resetsAt: NOW + 3 * 86400e3 }] },
    { ...base, provider: "zai", label: "GLM", kind: "windows", plan: "Coding plan", windows: [{ name: "5h", usedPct: 95, resetsAt: NOW + 3600e3 }] },
    { ...base, provider: "kimi", label: "Kimi", kind: "quota", remainingPct: null, detail: "usage unread" },
    { ...base, provider: "deepseek", label: "DeepSeek", kind: "prepaid", remaining: 36, usage: 14, limit: 50, currency: "USD" },
  ];
  const cards = planCards(rows, NOW, NOW);
  const by = (key: string) => cards.find(c => c.key === key);

  it("shows the tightest window as the headline and warns near the limit", () => {
    expect(by("claude")).toMatchObject({ headline: "22% of 5h window", warn: false, noMeter: false });
    expect(by("zai")).toMatchObject({ headline: "95% of 5h window", warn: true });
    expect(by("zai")?.forecast).toMatch(/^runs out/);
  });

  it("renders no meter for a provider that exposes none", () => {
    expect(by("kimi")).toMatchObject({ headline: "no meter", noMeter: true, pct: null, forecast: null, detail: "usage unread" });
  });

  it("reads a capped prepaid provider as used of cap", () => {
    expect(by("deepseek")).toMatchObject({ headline: "$14.0 of $50.0", pct: 28 });
  });
});

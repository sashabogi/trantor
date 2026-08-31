// Usage roster drills — every branch of the pure helper the popover renders from: the 60/80
// tone breakpoints, worst-first ordering, the metric normalization per row kind, the honesty
// ladder, and the relative-time vocabulary. Pure inputs, pure assertions — no window.
import { describe, expect, it } from "vitest";
import {
  metricsFor, resetLabel, rowState, ROSTER_COPY, setUsageDensity, timeAgo, tightestPct,
  usageDensity, usageTone, worstFirst,
} from "./usageRoster";
import type { BalanceRow } from "./balanceChips";

const row = (r: Partial<BalanceRow>): BalanceRow => ({
  provider: "openrouter", label: "OpenRouter", kind: "prepaid", ok: true, low: false,
  remaining: null, currency: "USD", remainingPct: null, ...r,
});

describe("usageTone — the shared 60/80 breakpoints (bar and text call the same fn)", () => {
  it("neutral below 60", () => {
    expect(usageTone(0)).toBe("ok");
    expect(usageTone(59.9)).toBe("ok");
  });
  it("warn at 60, still warn at 79.9", () => {
    expect(usageTone(60)).toBe("warn");
    expect(usageTone(79.9)).toBe("warn");
  });
  it("fail at 80 and beyond", () => {
    expect(usageTone(80)).toBe("fail");
    expect(usageTone(100)).toBe("fail");
  });
});

describe("metricsFor — one normalized window shape per row kind", () => {
  it("windows rows carry one metric per window, scoped windows lose the countdown", () => {
    const ms = metricsFor(row({
      kind: "windows",
      windows: [
        { name: "5h", usedPct: 8, resetsAt: 1_000 },
        { name: "7d", usedPct: 24, resetsAt: 2_000 },
        { name: "Fable", usedPct: 37, resetsAt: 3_000, scoped: true },
      ],
    }));
    expect(ms.map(m => m.label)).toEqual(["5-hour window", "weekly", "Fable"]);
    expect(ms.map(m => m.pct)).toEqual([8, 24, 37]);
    expect(ms[2].resetAt).toBeNull(); // scoped: the "37% used Fable" rule — no countdown
    expect(ms[0].resetAt).toBe(1_000);
  });
  it("quota rows flip remaining into used, counting up", () => {
    const ms = metricsFor(row({ kind: "quota", remainingPct: 85, resetTime: 5_000 }));
    expect(ms).toHaveLength(1);
    expect(ms[0].pct).toBe(15);
    expect(ms[0].resetAt).toBe(5_000);
  });
  it("prepaid rows honestly carry no percentage", () => {
    const ms = metricsFor(row({ kind: "prepaid", remaining: 9.7 }));
    expect(ms).toHaveLength(1);
    expect(ms[0].pct).toBeNull();
  });
  it("rows without numbers normalize to nothing", () => {
    expect(metricsFor(row({ kind: "subscription" }))).toEqual([]);
    expect(metricsFor(row({ kind: "quota", remainingPct: null }))).toEqual([]);
  });
});

describe("worstFirst — the agent nearest a limit sits on top", () => {
  it("sorts by tightest used% desc", () => {
    const a = row({ provider: "a", kind: "quota", remainingPct: 90 });  // 10% used
    const b = row({ provider: "b", kind: "quota", remainingPct: 20 });  // 80% used
    const c = row({ provider: "c", kind: "quota", remainingPct: 50 });  // 50% used
    expect(worstFirst([a, b, c]).map(r => r.provider)).toEqual(["b", "c", "a"]);
  });
  it("the worst window of a multi-window row is what sorts it", () => {
    const w = row({ provider: "w", kind: "windows", windows: [{ name: "5h", usedPct: 5 }, { name: "7d", usedPct: 95 }] });
    const q = row({ provider: "q", kind: "quota", remainingPct: 50 });
    expect(worstFirst([q, w])[0].provider).toBe("w");
    expect(tightestPct(w)).toBe(95);
  });
  it("rows with no number sink below rows that have one", () => {
    const plan = row({ provider: "plan", kind: "subscription" });
    const q = row({ provider: "q", kind: "quota", remainingPct: 99 }); // 1% used
    expect(worstFirst([plan, q]).map(r => r.provider)).toEqual(["q", "plan"]);
  });
});

describe("rowState — the honesty ladder", () => {
  it("a failed row is error, never a sign-in CTA", () => {
    expect(rowState(row({ ok: false, error: "409" }), true)).toBe("error");
    expect(ROSTER_COPY.error).toBe("unreachable");
  });
  it("a not-yet-pushed snapshot is loading", () => {
    expect(rowState(row({ kind: "quota", remainingPct: 50 }), false)).toBe("loading");
  });
  it("plan rows and unlimited rows are their own honest states", () => {
    expect(rowState(row({ kind: "subscription", plan: "Max" }), true)).toBe("plan");
    expect(rowState(row({ unlimited: true }), true)).toBe("unlimited");
  });
  it("rows with metrics are usage; ok rows without any are empty", () => {
    expect(rowState(row({ kind: "quota", remainingPct: 50 }), true)).toBe("usage");
    expect(rowState(row({ kind: "quota", remainingPct: null }), true)).toBe("empty");
  });
});

describe("relative time — the drill-in vocabulary", () => {
  it("timeAgo: just now / minutes / hours", () => {
    expect(timeAgo(0)).toBe("just now");
    expect(timeAgo(59_000)).toBe("just now");
    expect(timeAgo(120_000)).toBe("2m ago");
    expect(timeAgo(3 * 3_600_000)).toBe("3h ago");
  });
  it("resetLabel: countdown or nothing — never a fake date", () => {
    const in2h = Date.now() + 2 * 3_600_000;
    expect(resetLabel(in2h, Date.now())).toBe("Resets in 2h");
    expect(resetLabel(Date.now() - 1, Date.now())).toBe("Resets now");
    expect(resetLabel(null)).toBeNull();
    expect(resetLabel(undefined)).toBeNull();
  });
});

describe("usageDensity — persisted across popover close/reopen", () => {
  it("defaults to detailed and round-trips compact through storage", () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as Storage;
    expect(usageDensity()).toBe("detailed");
    setUsageDensity("compact");
    expect(usageDensity()).toBe("compact");
    setUsageDensity("detailed");
    expect(usageDensity()).toBe("detailed");
  });
  it("an unavailable storage still yields the default", () => {
    (globalThis as { localStorage?: Storage }).localStorage = undefined;
    expect(usageDensity()).toBe("detailed");
  });
});

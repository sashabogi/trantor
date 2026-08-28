// Fleet balance chip drills (#5555): every row kind → the one chip, all branches of the pure
// helper. Pure inputs, pure assertions — no window. Reset short-forms are asserted against
// Date.now()-relative timestamps so they cannot decay.
import { describe, expect, it } from "vitest";
import { chipFrom, type BalanceRow } from "./balanceChips";

const row = (r: Partial<BalanceRow>): BalanceRow => ({
  provider: "openrouter", label: "OpenRouter", kind: "prepaid", ok: true, low: false,
  remaining: null, currency: "USD", remainingPct: null, ...r,
});

describe("prepaid rows", () => {
  it("turns remaining into the one number — $ with one decimal", () => {
    const c = chipFrom(row({ remaining: 9.7 }));
    expect(c.label).toBe("OR");
    expect(c.value).toBe("$9.7");
    expect(c.reset).toBe("");
    expect(c.low).toBe(false);
  });

  it("uses the row's own currency symbol", () => {
    expect(chipFrom(row({ remaining: 40, currency: "CNY" })).value).toBe("¥40.0");
    expect(chipFrom(row({ remaining: 8, currency: "EUR" })).value).toBe("€8.0");
  });

  it("reads the low flag from the report — the hub owns thresholds, not us", () => {
    expect(chipFrom(row({ remaining: 2, low: true })).low).toBe(true);
    expect(chipFrom(row({ remaining: 2, low: false })).low).toBe(false);
  });

  it("says unlimited instead of a number when the key has no limit", () => {
    expect(chipFrom(row({ unlimited: true, remaining: null })).value).toBe("∞");
  });

  it("shows a question mark when a prepaid balance is unknown", () => {
    expect(chipFrom(row({ remaining: null })).value).toBe("?");
  });

  it("names usage and limit in the tooltip when the row carries them", () => {
    const c = chipFrom(row({ remaining: 9.7, usage: 2.25, limit: 12 }));
    expect(c.tooltip).toContain("$9.7 left");
    expect(c.tooltip).toContain("$2.3 used");
    expect(c.tooltip).toContain("$12.0 limit");
  });

  it("names the key source in the tooltip", () => {
    expect(chipFrom(row({ remaining: 5, via: "OPENROUTER_API_KEY" })).tooltip)
      .toBe("OpenRouter · $5.0 left · via OPENROUTER_API_KEY");
  });

  it("surfaces a fetch error instead of a number", () => {
    const c = chipFrom(row({ ok: false, error: "HTTP 401" }));
    expect(c.value).toBe("?");
    expect(c.tooltip).toContain("error: HTTP 401");
  });
});

describe("quota rows", () => {
  it("turns remainingPct into the number, with the reset suffix when known", () => {
    const c = chipFrom(row({ kind: "quota", remainingPct: 89, resetTime: Date.now() + 3600e3 }));
    expect(c.value).toBe("89%");
    expect(c.reset).toBe("·1h");
    expect(c.tooltip).toContain("89% left");
    expect(c.tooltip).toContain("resets in 1h");
  });

  it("omits the reset suffix when the row has no reset", () => {
    const c = chipFrom(row({ kind: "quota", remainingPct: 89 }));
    expect(c.reset).toBe("");
    expect(c.tooltip).not.toContain("resets in");
  });

  it("short-forms resets the same way the CLI does — days past 48h, soon when elapsed", () => {
    expect(chipFrom(row({ kind: "quota", remainingPct: 60, resetTime: Date.now() + 5 * 24 * 3600e3 })).reset).toBe("·5d");
    expect(chipFrom(row({ kind: "quota", remainingPct: 60, resetTime: Date.now() - 1000 })).reset).toBe("·soon");
  });

  it("ignores a garbage reset time", () => {
    expect(chipFrom(row({ kind: "quota", remainingPct: 60, resetTime: "not-a-time" })).reset).toBe("");
  });

  it("shows a question mark when the quota is unknown", () => {
    expect(chipFrom(row({ kind: "quota" })).value).toBe("?");
  });
});

describe("subscription rows", () => {
  it("reads as plan when a plan is named, sub when it is not", () => {
    expect(chipFrom(row({ provider: "kimi", kind: "subscription", plan: "Kimi Code" })).value).toBe("plan");
    expect(chipFrom(row({ provider: "codex", label: "codex", kind: "subscription" })).value).toBe("sub");
  });

  it("keeps the plan name in the tooltip", () => {
    expect(chipFrom(row({ kind: "subscription", plan: "pro" })).tooltip).toBe("OpenRouter · subscription · pro");
  });
});

describe("monograms", () => {
  it("maps the known crew providers to their short forms", () => {
    expect(chipFrom(row({ provider: "deepseek" })).label).toBe("DS");
    expect(chipFrom(row({ provider: "zai" })).label).toBe("GLM");
    expect(chipFrom(row({ provider: "glm" })).label).toBe("GLM");
    expect(chipFrom(row({ provider: "codex", kind: "subscription" })).label).toBe("Codex");
  });

  it("falls back to the label's first letters for an unknown provider", () => {
    expect(chipFrom(row({ provider: "mystery-provider", label: "Mystery AI" })).label).toBe("MYS");
  });
});

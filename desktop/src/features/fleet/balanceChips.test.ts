// Fleet balance chip drills (#5555, v7 revision): every row kind → the one chip, all branches of
// the pure helper. Pure inputs, pure assertions — no window. Reset short-forms are asserted
// against Date.now()-relative timestamps so they cannot decay.
import { describe, expect, it } from "vitest";
import { chipFrom, isStale, isZombie, sortRows, toneClass, untilLong, type BalanceRow } from "./balanceChips";

const row = (r: Partial<BalanceRow>): BalanceRow => ({
  provider: "openrouter", label: "OpenRouter", kind: "prepaid", ok: true, low: false,
  remaining: null, currency: "USD", remainingPct: null, ...r,
});

describe("prepaid rows", () => {
  it("turns remaining into the one number — $ with one decimal", () => {
    const c = chipFrom(row({ remaining: 9.7 }));
    expect(c).not.toBeNull();
    expect(c!.value).toBe("$9.7");
    expect(c!.mono).toBe("OR");
    expect(c!.tone).toBe("ok");
  });

  it("uses the row's own currency symbol", () => {
    expect(chipFrom(row({ remaining: 40, currency: "CNY" }))!.value).toBe("¥40.0");
    expect(chipFrom(row({ remaining: 8, currency: "EUR" }))!.value).toBe("€8.0");
  });

  it("reads the low flag from the report — the hub owns thresholds, not us", () => {
    expect(chipFrom(row({ remaining: 2, low: true }))!.tone).toBe("warn");
    expect(chipFrom(row({ remaining: 2, low: false }))!.tone).toBe("ok");
  });

  it("says unlimited instead of a number when the key has no limit", () => {
    expect(chipFrom(row({ unlimited: true, remaining: null }))!.value).toBe("∞");
  });

  it("shows a question mark when a prepaid balance is unknown", () => {
    expect(chipFrom(row({ remaining: null }))!.value).toBe("?");
  });

  it("names usage and limit in the tooltip when the row carries them", () => {
    const c = chipFrom(row({ remaining: 9.7, usage: 2.25, limit: 12 }))!;
    expect(c.tooltip).toContain("$9.7 left");
    expect(c.tooltip).toContain("$2.3 used");
    expect(c.tooltip).toContain("$12.0 limit");
  });

  it("names the key source in the tooltip", () => {
    expect(chipFrom(row({ remaining: 5, via: "OPENROUTER_API_KEY" }))!.tooltip)
      .toBe("OpenRouter · $5.0 left · via OPENROUTER_API_KEY");
  });

  it("surfaces a fetch error instead of a number, tinted fail", () => {
    const c = chipFrom(row({ ok: false, error: "HTTP 401" }))!;
    expect(c.value).toBe("?");
    expect(c.tone).toBe("fail");
    expect(c.tooltip).toContain("error: HTTP 401");
  });
});

describe("quota rows", () => {
  it("reads as USED counting up, Orca-style, with the time-left beside it (#5570)", () => {
    const c = chipFrom(row({ kind: "quota", remainingPct: 89, resetTime: Date.now() + 3600e3 }))!;
    expect(c.value).toBe("11% used 1h");
    expect(c.barPct).toBe(11);
    expect(c.tooltip).toContain("89% left");
    expect(c.tooltip).toContain("resets in 1h");
  });

  it("omits the reset suffix when the row has no reset", () => {
    const c = chipFrom(row({ kind: "quota", remainingPct: 89 }))!;
    expect(c.tooltip).not.toContain("resets in");
  });

  it("short-forms resets the same way the CLI does — days past 48h, soon when elapsed", () => {
    expect(chipFrom(row({ kind: "quota", remainingPct: 60, resetTime: Date.now() + 5 * 24 * 3600e3 }))!.tooltip).toContain("resets in 5d");
    expect(chipFrom(row({ kind: "quota", remainingPct: 60, resetTime: Date.now() - 1000 }))!.tooltip).toContain("resets in soon");
  });

  it("ignores a garbage reset time", () => {
    expect(chipFrom(row({ kind: "quota", remainingPct: 60, resetTime: "not-a-time" }))!.tooltip).not.toContain("resets in");
  });

  it("shows a question mark when the quota is unknown", () => {
    expect(chipFrom(row({ kind: "quota" }))!.value).toBe("?");
  });
});

describe("windows rows (Claude)", () => {
  const win = (name: string, usedPct: number, resetsAt?: number) => ({ name, usedPct, resetsAt: resetsAt ?? null, locked: null });

  it("reads each window as 'N% used <time-left>' — the Orca standard (#5570)", () => {
    const c = chipFrom(row({
      provider: "claude", label: "Claude", kind: "windows",
      windows: [win("5h", 10, Date.now() + 2 * 3600e3), win("7d", 24, Date.now() + 5 * 24 * 3600e3)],
    }))!;
    expect(c.value).toBe("10% used 2h · 24% used 5d");
    expect(c.barPct).toBe(10);
    expect(c.icon).toBe("claude");
    expect(c.tooltip).toContain("5-hour window 10% used, resets in 2h");
    expect(c.tooltip).toContain("weekly 24% used, resets in 5d");
    expect(c.tone).toBe("ok");
  });

  it("a model-SCOPED window shows its name instead of a countdown — '37% used Fable'", () => {
    const c = chipFrom(row({
      provider: "claude", label: "Claude", kind: "windows",
      windows: [win("5h", 8, Date.now() + 5 * 3600e3), win("7d", 30, Date.now() + 3 * 24 * 3600e3),
                { name: "Fable", usedPct: 37, resetsAt: Date.now() + 3 * 24 * 3600e3, locked: null, scoped: true }],
    }))!;
    expect(c.value).toContain("37% used Fable");
    expect(c.value).not.toContain("Fable ·");
  });

  it("codex windows ride the same shape with the openai mark", () => {
    const c = chipFrom(row({
      provider: "codex", label: "Codex", kind: "windows",
      windows: [win("5h", 61, Date.now() + 12 * 60e3), win("7d", 25, Date.now() + 5 * 24 * 3600e3 + 20 * 3600e3)],
    }))!;
    expect(c.value).toBe("61% used 12m · 25% used 5d 20h");
    expect(c.icon).toBe("codex");
  });

  it("tints tr-warn when a window is LOW — remaining under 15%", () => {
    const c = chipFrom(row({
      provider: "claude", kind: "windows",
      windows: [win("5h", 92, Date.now() + 3600e3), win("7d", 24)],
    }))!;
    expect(c.tone).toBe("warn");
  });

  it("tints tr-fail and names the lock when a window is locked", () => {
    const c = chipFrom(row({
      provider: "claude", kind: "windows",
      windows: [{ name: "5h", usedPct: 10, resetsAt: null, locked: "concurrent" }, win("7d", 24)],
    }))!;
    expect(c.tone).toBe("fail");
    expect(c.tooltip).toContain("LOCKED");
  });

  it("shows a question mark when no window has a number", () => {
    expect(chipFrom(row({ provider: "claude", kind: "windows", windows: [{ name: "5h", usedPct: null, resetsAt: null, locked: null }] }))!.value).toBe("?");
  });
});

describe("subscription / plan-only rows", () => {
  it("renders icon + 'plan' — small, honest, never a fake number", () => {
    expect(chipFrom(row({ provider: "kimi", kind: "subscription", plan: "Kimi Code" }))!.value).toBe("plan");
    expect(chipFrom(row({ provider: "codex", label: "codex", kind: "subscription" }))!.value).toBe("plan");
  });

  it("keeps the plan name in the tooltip", () => {
    expect(chipFrom(row({ kind: "subscription", plan: "pro" }))!.tooltip).toBe("OpenRouter · subscription · pro");
  });
});

describe("brand monograms", () => {
  it("maps the known crew providers to their hue + monogram", () => {
    const claude = chipFrom(row({ provider: "claude", label: "Claude", kind: "windows" }))!;
    expect(claude.mono).toBe("Cl");
    expect(claude.hue).toBe("#D97757");
    expect(chipFrom(row({ provider: "deepseek" }))!.mono).toBe("DS");
    expect(chipFrom(row({ provider: "zai" }))!.mono).toBe("GL");
    expect(chipFrom(row({ provider: "glm" }))!.mono).toBe("GL");
    expect(chipFrom(row({ provider: "codex", kind: "subscription" }))!.mono).toBe("Cx");
    expect(chipFrom(row({ provider: "openrouter" }))!.mono).toBe("OR");
  });

  it("falls back to the label's first letters for an unknown provider", () => {
    expect(chipFrom(row({ provider: "mystery-provider", label: "Mystery AI" }))!.mono).toBe("MY");
  });
});

describe("staleness and zombies", () => {
  it("isStale dims once the snapshot is older than 30 min", () => {
    expect(isStale(Date.now())).toBe(false);
    expect(isStale(Date.now() - 31 * 60 * 1000)).toBe(true);
    expect(isStale(0)).toBe(false);
  });

  it("a stale snapshot earns an 'as of' line in the tooltip", () => {
    const c = chipFrom(row({ remaining: 5 }), { snapshotTs: Date.now() - 2 * 3600e3 })!;
    expect(c.stale).toBe(true);
    expect(c.tooltip).toContain("as of 2h ago");
  });

  it("a fresh snapshot stays unstale with no as-of line", () => {
    const c = chipFrom(row({ remaining: 5 }), { snapshotTs: Date.now() })!;
    expect(c.stale).toBe(false);
    expect(c.tooltip).not.toContain("as of");
  });

  it("a gemini zombie row hides once the snapshot is older than 24h", () => {
    const z = row({ provider: "gemini", label: "Gemini", kind: "subscription", plan: "deprecated" });
    expect(chipFrom(z, { snapshotTs: Date.now() - 25 * 3600e3 })).toBeNull();
    expect(isZombie(z, Date.now() - 25 * 3600e3)).toBe(true);
  });

  it("a gemini row hides even on a FRESH snapshot — the CLI is retired, a row is always a ghost", () => {
    const z = row({ provider: "gemini", label: "Gemini", kind: "subscription", plan: "deprecated" });
    expect(isZombie(z, Date.now())).toBe(true);
    expect(chipFrom(z, { snapshotTs: Date.now() })).toBeNull();
    expect(isZombie(row({ provider: "codex", kind: "subscription", plan: "plus" }), Date.now() - 25 * 3600e3)).toBe(false);
  });
});

describe("brightness classes", () => {
  it("ok reads at full text brightness, warn and fail carry the status tint", () => {
    expect(toneClass("ok")).toBe("text-[var(--color-tr-text)]");
    expect(toneClass("warn")).toBe("text-[var(--color-tr-warn)]");
    expect(toneClass("fail")).toBe("text-[var(--color-tr-fail)]");
  });
});

describe("chip order", () => {
  it("sorts Claude (windows) first, then prepaid $, then quota, then plan", () => {
    const sub = row({ provider: "kimi", kind: "subscription", plan: "Kimi Code" });
    const quota = row({ provider: "zai", kind: "quota", remainingPct: 50 });
    const prepaid = row({ provider: "openrouter", remaining: 5 });
    const claude = row({ provider: "claude", kind: "windows", windows: [] });
    const sorted = sortRows([sub, quota, prepaid, claude]).map(e => e.provider);
    expect(sorted).toEqual(["claude", "openrouter", "zai", "kimi"]);
  });
});

describe("untilLong — the Orca countdown", () => {
  const now = Date.now();
  it("two units, largest first", () => {
    expect(untilLong(now + (5 * 24 + 4) * 3600e3 + 30e3, now)).toBe("5d 4h");
    expect(untilLong(now + 105 * 60e3, now)).toBe("1h 45m");
    expect(untilLong(now + 12 * 60e3, now)).toBe("12m");
    expect(untilLong(now + 24 * 3600e3, now)).toBe("1d");
  });
  it("past or garbage is honest", () => {
    expect(untilLong(now - 1000, now)).toBe("now");
    expect(untilLong("not-a-time", now)).toBe(null);
    expect(untilLong(null, now)).toBe(null);
  });
});

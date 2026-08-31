// Usage roster — the pure formatting behind the Usage popover, the same split the balance
// chips use: every decision lives here so the popover stays a dumb renderer and the drillable
// surface is the logic. The data is whatever BalanceStrip ALREADY pulled from the local hub
// (/balances) — this module never fetches, it only presents (the correction to the card note:
// do not rewire the data plane, just present it).
//
// Orca parity (docs/RESEARCH-orca-usage.md §4+§6): worst-first roster order, one shared
// 60/80 tone function for bars AND text (they can never disagree), a six-way honesty ladder
// (usage/loading/plan/unlimited/error/empty — never a sign-in CTA, because this data plane
// cannot know credentials; a transient fetch error must not read as "sign in again"),
// "Updated {timeAgo}" and "Resets in {countdown}" in the drill-in.
import type { BalanceRow } from "./balanceChips";
import { untilLong, WINDOW_LABEL } from "./balanceChips";
import { dictGet } from "../../shared/dict";

export type ChipTone = "ok" | "warn" | "fail";

// Orca's shared breakpoints (§4.1): <60% neutral, 60–80% warn, ≥80% fail. The bar fill and the
// percent text BOTH call this, so the popover can never disagree with itself about urgency.
export function usageTone(usedPct: number): ChipTone {
  if (usedPct >= 80) return "fail";
  if (usedPct >= 60) return "warn";
  return "ok";
}

// One normalized usage window, whatever row kind it came from.
export type UsageMetric = {
  label: string;
  pct: number | null; // used%, counting up — null when the row honestly has no number
  resetAt: number | string | null;
  scoped: boolean; // a model-scoped window ("Fable") never shows a countdown
};

export function metricsFor(e: BalanceRow): UsageMetric[] {
  if (e.kind === "windows") {
    return (e.windows ?? []).filter(Boolean).map(w => ({
      label: w.scoped ? w.name : (dictGet(WINDOW_LABEL, w.name) ?? `${w.name} window`),
      pct: w.usedPct ?? null,
      resetAt: w.scoped ? null : (w.resetsAt ?? null),
      scoped: !!w.scoped,
    }));
  }
  if (e.kind === "quota" && e.remainingPct != null) {
    return [{ label: "Quota", pct: Math.max(0, Math.min(100, 100 - Math.round(e.remainingPct))), resetAt: e.resetTime ?? null, scoped: false }];
  }
  if (e.kind === "prepaid" && e.remaining != null) {
    return [{ label: "Balance", pct: null, resetAt: null, scoped: false }];
  }
  return [];
}

// The tightest window = the one nearest its limit — what compact mode shows and what sorts
// the roster (§4.2: "the agent nearest a limit sits on top").
export function tightestPct(e: BalanceRow): number | null {
  const ps = metricsFor(e).map(m => m.pct).filter((p): p is number => p != null);
  return ps.length ? Math.max(...ps) : null;
}

// Worst-first roster order: rows with a used% by that % desc; rows with no number sink below
// (alphabetical among themselves) — never above a row that is actually running out.
export function worstFirst(rows: BalanceRow[]): BalanceRow[] {
  return [...rows].sort((a, b) => {
    const pa = tightestPct(a), pb = tightestPct(b);
    if (pa != null && pb != null) return pb - pa;
    if (pa != null) return -1;
    if (pb != null) return 1;
    return a.provider.localeCompare(b.provider);
  });
}

// The honesty ladder (§4.2 six-way, adapted to a data plane that shells the local CLI and so
// cannot know credential state — hence no "sign in" state at all, deliberately).
export type RosterRowState = "usage" | "loading" | "plan" | "unlimited" | "error" | "empty";

export function rowState(e: BalanceRow, snapshotFresh: boolean): RosterRowState {
  if (!e.ok) return "error";
  if (!snapshotFresh) return "loading";
  if (e.kind === "subscription") return "plan";
  if (e.unlimited) return "unlimited";
  if (metricsFor(e).length) return "usage";
  return "empty";
}

export const ROSTER_COPY: Record<RosterRowState, string> = {
  usage: "",
  loading: "waiting for a snapshot…",
  plan: "plan",
  unlimited: "unlimited — nothing to refill",
  error: "unreachable",
  empty: "no usage data",
};

// §4.3 "Updated {timeAgo}": "just now" under a minute, minutes under an hour, else hours.
export function timeAgo(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

// §4.3 "Resets in {duration}" — untilLong's two-unit countdown; a window already past reads
// "Resets now", and no reset time means no line at all (never a fake date).
export function resetLabel(t: number | string | null | undefined, now = Date.now()): string | null {
  const s = untilLong(t, now);
  if (!s) return null;
  return s === "now" ? "Resets now" : `Resets in ${s}`;
}

// Detailed/Compact density (§4.2 point 2): a persisted setting at the call site, not component
// state, so it survives popover close/reopen and app restart. localStorage IS the settings
// store this app already uses (tr.notifications, tr.editor).
export type UsageDensity = "detailed" | "compact";

export function usageDensity(): UsageDensity {
  try { return localStorage.getItem("tr.usageDensity") === "compact" ? "compact" : "detailed"; }
  catch { return "detailed"; }
}

export function setUsageDensity(d: UsageDensity): void {
  try { localStorage.setItem("tr.usageDensity", d); } catch { /* private mode — default holds */ }
}

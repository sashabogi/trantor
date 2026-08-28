// Fleet balance chips — the pure formatting that turns a /balances row into the one chip that
// belongs in the app header: a brand-hue monogram circle + the single number that matters. All
// decision logic lives here so the strip component stays a dumb renderer and the drillable
// surface is the formatting itself. Semantics mirror lib/balances.mjs (symbols, reset short-forms,
// kind shapes) so the header and the CLI agree about what a row means.
//
// v7: ICONS not words — the value reads at full brightness (text-tr-text), the icon/label stays
// muted. A stale snapshot (older than 30 min) dims the chip AND says so in the tooltip ("as of
// 2h ago"). Claude's two usage windows fold into one chip ("10% · 24%"); a stale zombie row
// (gemini, snapshot older than 24h) is HIDDEN entirely.
import type { BalanceEntry } from "../../shared/api/client";
import { dictGet } from "../../shared/dict";

// The hub's /balances rows carry MORE than the client's conservative BalanceEntry declares: the
// fetch adapters spread the raw provider payload (usage/limit/resetTime/via/unlimited/windows)
// into each entry before POSTing. The strip reads those extra fields, so the boundary cast widens
// once, in the component — never scattered through the formatter. kind also widens: the frozen
// client type predates the Claude "windows" row the orchestrator ships.
export type BalanceWindow = {
  name: string;
  usedPct?: number | null;
  resetsAt?: number | string | null;
  locked?: string | boolean | null;
};

export type BalanceRow = Omit<BalanceEntry, "kind"> & {
  kind: BalanceEntry["kind"] | "windows";
  usage?: number | null;
  limit?: number | null;
  resetTime?: number | string | null;
  via?: string;
  unlimited?: boolean;
  detail?: string;
  error?: string;
  windows?: BalanceWindow[];
};

export type ChipTone = "ok" | "warn" | "fail";

export type BalanceChip = {
  key: string;
  mono: string;   // the monogram letters, e.g. "Cl", "Cx", "DS"
  hue: string;    // brand hue — the circle's background
  fg: string;     // monogram text color inside the circle (contrast vs the hue)
  value: string;  // the number(s) that matter, e.g. "$9.7", "10% · 24%", "plan"
  tone: ChipTone; // brightness/tint class: ok = full text brightness, warn/fail = status tint
  stale: boolean; // snapshot older than 30 min → dim the chip + "as of" in the tooltip
  tooltip: string; // full label, exact numbers, staleness line, and the key source
};

export type ChipOpts = { now?: number; snapshotTs?: number };

// Chip staleness / zombie thresholds (mirror the CLI's sense of "left"):
const STALE_DIM_MS = 30 * 60 * 1000;          // dim + "as of" once the snapshot is half an hour old
const ZOMBIE_HIDE_MS = 24 * 3600 * 1000;      // a gemini zombie row hides once the snapshot is a day old
const LOW_QUOTA_PCT = 15;                     // mirrors lib/balances.mjs DEFAULT_LOW_QUOTA_PCT

// Each provider gets a small circular monogram in its brand hue (operator-chosen): Claude
// terracotta, OpenAI teal-ish for Codex, DeepSeek blue, GLM indigo, Kimi dark, OpenRouter violet.
const BRAND: Record<string, { mono: string; hue: string; fg: string }> = {
  claude:     { mono: "Cl", hue: "#D97757", fg: "#1c110b" },
  anthropic:  { mono: "Cl", hue: "#D97757", fg: "#1c110b" },
  codex:      { mono: "Cx", hue: "#2DD4BF", fg: "#0a1a18" },
  openai:     { mono: "Cx", hue: "#2DD4BF", fg: "#0a1a18" },
  deepseek:   { mono: "DS", hue: "#4D6BFE", fg: "#eef1ff" },
  zai:        { mono: "GL", hue: "#6366F1", fg: "#eef0ff" },
  glm:        { mono: "GL", hue: "#6366F1", fg: "#eef0ff" },
  zhipu:      { mono: "GL", hue: "#6366F1", fg: "#eef0ff" },
  kimi:       { mono: "Ki", hue: "#3A3A40", fg: "#f2f2f5" },
  moonshot:   { mono: "MS", hue: "#3A3A40", fg: "#f2f2f5" },
  gemini:     { mono: "Ge", hue: "#8A8A92", fg: "#1a1a1e" },
  openrouter: { mono: "OR", hue: "#8B5CF6", fg: "#f1ecff" },
};

const WINDOW_LABEL: Record<string, string> = { "5h": "5-hour window", "7d": "weekly" };

const SYMBOL: Record<string, string> = { USD: "$", CNY: "¥", EUR: "€" };

function money(v: number, currency?: string): string {
  return `${SYMBOL[currency ?? "USD"] ?? "$"}${v.toFixed(1)}`;
}

// Reset-time short form, mirrored from lib/balances.mjs fmtReset so chip and CLI agree: under
// 48h → "5h", beyond → "3d", already past → "soon". Null when the row has no reset.
function resetShort(t: number | string | null | undefined): string | null {
  if (t == null || t === "") return null;
  const ms = typeof t === "number" ? t : Date.parse(t);
  if (!ms || Number.isNaN(ms)) return null;
  const hrs = (ms - Date.now()) / 3600e3;
  if (hrs < 0) return "soon";
  if (hrs < 48) return `${Math.round(hrs)}h`;
  return `${Math.round(hrs / 24)}d`;
}

// "as of 2h ago" — the staleness line a stale snapshot earns.
function agoLabel(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(ms / 3600000);
  if (hrs < 48) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

// The Claude windows row folds BOTH windows into one chip: value "10% · 24%", tone from LOW
// (remaining < LOW_QUOTA_PCT) or locked, tooltip spells each window with its reset.
function windowsInfo(e: BalanceRow): { value: string; tone: ChipTone; tooltip: string } {
  const wins = (e.windows ?? []).filter(Boolean);
  const pcts = wins.filter(w => w.usedPct != null).map(w => `${Math.round(w.usedPct as number)}%`);
  const value = pcts.length ? pcts.join(" · ") : "?";
  const locked = wins.some(w => w.locked);
  const low = !locked && wins.some(w => w.usedPct != null && (100 - (w.usedPct as number)) < LOW_QUOTA_PCT);
  const tone: ChipTone = locked ? "fail" : low ? "warn" : "ok";
  const parts = wins.map(w => {
    const label = dictGet(WINDOW_LABEL, w.name) ?? `${w.name} window`;
    const used = w.usedPct != null ? `${Math.round(w.usedPct)}% used` : "usage unknown";
    const rs = w.resetsAt ? resetShort(w.resetsAt) : null;
    const rl = rs ? (rs === "soon" ? "resets soon" : `resets in ${rs}`) : "";
    const lk = w.locked ? " · LOCKED" : "";
    return `${label} ${used}${rl ? `, ${rl}` : ""}${lk}`;
  });
  return { value, tone, tooltip: parts.join(" · ") || "windows unknown" };
}

// A stale snapshot (ts older than 30 min) dims the strip AND earns a tooltip line; a gemini zombie
// row disappears entirely once the snapshot is a day old.
export function isStale(snapshotTs: number, now = Date.now()): boolean {
  return snapshotTs > 0 && now - snapshotTs > STALE_DIM_MS;
}

export function isZombie(e: BalanceRow, snapshotTs: number, now = Date.now()): boolean {
  return e.provider === "gemini" && snapshotTs > 0 && now - snapshotTs > ZOMBIE_HIDE_MS;
}

// Brightness/tone class: ok = the VALUE reads at full text brightness; warn/fail carry the status
// tint. Muted stays reserved for the icon/label in the component.
export function toneClass(tone: ChipTone): string {
  if (tone === "warn") return "text-[var(--color-tr-warn)]";
  if (tone === "fail") return "text-[var(--color-tr-fail)]";
  return "text-[var(--color-tr-text)]";
}

// Chip order: Claude (windows) first, then prepaid $ rows, then quota rows, then plan rows.
const KIND_ORDER: Record<string, number> = { windows: 0, prepaid: 1, quota: 2, subscription: 3 };

export function sortRows(rows: BalanceRow[]): BalanceRow[] {
  return [...rows].sort((a, b) => (KIND_ORDER[a.kind] ?? 4) - (KIND_ORDER[b.kind] ?? 4));
}

export function chipFrom(e: BalanceRow, opts: ChipOpts = {}): BalanceChip | null {
  const now = opts.now ?? Date.now();
  const snap = opts.snapshotTs ?? 0;
  if (isZombie(e, snap, now)) return null;

  const brand = dictGet(BRAND, e.provider)
    ?? { mono: (e.label ?? e.provider).slice(0, 2).toUpperCase(), hue: "#8A8A92", fg: "#1a1a1e" };
  const full = e.label ?? e.provider;
  let value = "?";
  let tone: ChipTone = "ok";
  let detail: string;

  if (!e.ok) {
    detail = e.error ? `error: ${e.error}` : "unreachable";
    tone = "fail";
  } else if (e.kind === "windows") {
    const w = windowsInfo(e);
    value = w.value; tone = w.tone; detail = w.tooltip;
  } else if (e.kind === "quota") {
    const rs = resetShort(e.resetTime);
    if (e.remainingPct != null) {
      const pct = Math.round(e.remainingPct);
      value = `${pct}%`;
      detail = `${pct}% left${rs ? ` · resets in ${rs}` : ""}`;
      if (e.low) tone = "warn";
    } else {
      detail = "quota unknown";
    }
  } else if (e.kind === "subscription") {
    // rows with no numbers (Codex subscription, plan-only rows): icon + "plan" — small, honest,
    // never a fake number.
    const p = (e.plan ?? "").trim();
    value = "plan";
    detail = p ? `subscription · ${p}` : "subscription";
  } else if (e.unlimited) {
    value = "∞";
    detail = "unlimited — nothing to refill";
  } else if (e.remaining == null) {
    detail = "balance unknown";
  } else {
    value = money(e.remaining, e.currency);
    const parts = [`${money(e.remaining, e.currency)} left`];
    if (e.usage != null) parts.push(`${money(e.usage, e.currency)} used`);
    if (e.limit != null) parts.push(`${money(e.limit, e.currency)} limit`);
    detail = parts.join(" · ");
    if (e.low) tone = "warn";
  }

  const via = e.via ? ` · via ${e.via}` : "";
  const stale = isStale(snap, now);
  const staleLine = stale ? ` · as of ${agoLabel(now - snap)} ago` : "";
  return {
    key: e.provider, mono: brand.mono, hue: brand.hue, fg: brand.fg,
    value, tone, stale, tooltip: `${full} · ${detail}${via}${staleLine}`,
  };
}

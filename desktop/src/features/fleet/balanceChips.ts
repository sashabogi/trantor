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
  scoped?: boolean; // a model-scoped window ("Fable") shows its scope name, never a countdown
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
  mono: string;   // monogram fallback for providers without a vendored brand mark
  icon: string | null; // BRAND_PATHS key — the real brand glyph (#5570, the Orca standard)
  hue: string;    // brand hue — tints the mark
  fg: string;     // monogram text color (fallback rendering only)
  value: string;  // Orca segments: "8% used 4h 32m · 30% used 3d 2h · 37% used Fable"
  barPct: number | null; // micro progress bar fill (used%) — null hides the bar
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
// Real brand marks (brands.ts, vendored) tinted in the brand hue; the monogram survives only
// as the fallback for providers without a vendored glyph.
type BrandStyle = { mono: string; icon: string | null; hue: string; fg: string };
const BRAND = {
  claude:     { mono: "Cl", icon: "claude",     hue: "#D97757", fg: "#1c110b" },
  anthropic:  { mono: "Cl", icon: "claude",     hue: "#D97757", fg: "#1c110b" },
  codex:      { mono: "Cx", icon: "codex",      hue: "#E4E4E7", fg: "#0a1a18" },
  openai:     { mono: "Cx", icon: "codex",      hue: "#E4E4E7", fg: "#0a1a18" },
  deepseek:   { mono: "DS", icon: "deepseek",   hue: "#4D6BFE", fg: "#eef1ff" },
  zai:        { mono: "GL", icon: "glm",        hue: "#6366F1", fg: "#eef0ff" },
  glm:        { mono: "GL", icon: "glm",        hue: "#6366F1", fg: "#eef0ff" },
  zhipu:      { mono: "GL", icon: "glm",        hue: "#6366F1", fg: "#eef0ff" },
  kimi:       { mono: "Ki", icon: "kimi",       hue: "#C9C9CF", fg: "#f2f2f5" },
  moonshot:   { mono: "MS", icon: "kimi",       hue: "#C9C9CF", fg: "#f2f2f5" },
  gemini:     { mono: "Ge", icon: null,         hue: "#8A8A92", fg: "#1a1a1e" },
  openrouter: { mono: "OR", icon: "openrouter", hue: "#8B5CF6", fg: "#f1ecff" },
} satisfies Record<string, BrandStyle>;

const WINDOW_LABEL = { "5h": "5-hour window", "7d": "weekly" } satisfies Record<string, string>;

const SYMBOL = { USD: "$", CNY: "¥", EUR: "€" } satisfies Record<string, string>;

function money(v: number, currency?: string): string {
  return `${dictGet(SYMBOL, currency ?? "USD") ?? "$"}${v.toFixed(1)}`;
}

// Reset times arrive from the hub as epoch ms OR an ISO string (provider-dependent). The Date
// constructor is the boundary decoder for exactly that union — a number rides through as epoch
// ms, a string gets parsed — so resetShort and untilLong decode HERE, once, then branch on the
// plain number. Null means the row carries no usable reset (0 and NaN included).
function epochMs(t: number | string | null | undefined): number | null {
  if (t == null || t === "") return null;
  const ms = new Date(t).getTime();
  return !ms || Number.isNaN(ms) ? null : ms;
}

// Reset-time short form, mirrored from lib/balances.mjs fmtReset so chip and CLI agree: under
// 48h → "5h", beyond → "3d", already past → "soon". Null when the row has no reset.
function resetShort(t: number | string | null | undefined): string | null {
  const ms = epochMs(t);
  if (ms == null) return null;
  const hrs = (ms - Date.now()) / 3600e3;
  if (hrs < 0) return "soon";
  if (hrs < 48) return `${Math.round(hrs)}h`;
  return `${Math.round(hrs / 24)}d`;
}

// The Orca-standard time-remaining: two units, largest first — "1h 45m", "5d 4h", "12m".
// This is what sits beside "N% used" in the status bar, so it reads as a countdown, not a date.
export function untilLong(t: number | string | null | undefined, now = Date.now()): string | null {
  const ms = epochMs(t);
  if (ms == null) return null;
  let mins = Math.floor((ms - now) / 60000);
  if (mins <= 0) return "now";
  const d = Math.floor(mins / 1440); mins -= d * 1440;
  const h = Math.floor(mins / 60); const m = mins - h * 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

// "as of 2h ago" — the staleness line a stale snapshot earns.
function agoLabel(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(ms / 3600000);
  if (hrs < 48) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

// A windows row reads as Orca's footer does: one segment per window, "N% used <time-left>",
// and a model-SCOPED window shows its scope's name instead of a countdown ("37% used Fable" —
// the time matches the weekly anyway). Tone from LOW (remaining < LOW_QUOTA_PCT) or locked.
type WindowsInfo = { value: string; barPct: number | null; tone: ChipTone; tooltip: string };
function windowsInfo(e: BalanceRow, now: number): WindowsInfo {
  const wins = (e.windows ?? []).filter(Boolean);
  const seg = (w: BalanceWindow) => {
    if (w.usedPct == null) return null;
    const used = `${Math.round(w.usedPct)}% used`;
    if (w.scoped || !dictGet(WINDOW_LABEL, w.name)) return `${used} ${w.name}`;
    const t = untilLong(w.resetsAt, now);
    return t ? `${used} ${t}` : used;
  };
  const segs = wins.map(seg).filter((s): s is string => s != null);
  const value = segs.length ? segs.join(" · ") : "?";
  const barPct = wins.length && wins[0].usedPct != null ? Math.round(wins[0].usedPct) : null;
  const locked = wins.some(w => w.locked);
  const low = !locked && wins.some(w => w.usedPct != null && (100 - w.usedPct) < LOW_QUOTA_PCT);
  const tone: ChipTone = locked ? "fail" : low ? "warn" : "ok";
  const parts = wins.map(w => {
    const label = dictGet(WINDOW_LABEL, w.name) ?? `${w.name} window`;
    const used = w.usedPct != null ? `${Math.round(w.usedPct)}% used` : "usage unknown";
    const rs = w.resetsAt ? resetShort(w.resetsAt) : null;
    const rl = rs ? (rs === "soon" ? "resets soon" : `resets in ${rs}`) : "";
    const lk = w.locked ? " · LOCKED" : "";
    return `${label} ${used}${rl ? `, ${rl}` : ""}${lk}`;
  });
  return { value, barPct, tone, tooltip: parts.join(" · ") || "windows unknown" };
}

// A stale snapshot (ts older than 30 min) dims the strip AND earns a tooltip line; a gemini zombie
// row disappears entirely once the snapshot is a day old.
export function isStale(snapshotTs: number, now = Date.now()): boolean {
  return snapshotTs > 0 && now - snapshotTs > STALE_DIM_MS;
}

export function isZombie(e: BalanceRow, snapshotTs: number, now = Date.now()): boolean {
  // Gemini's CLI was retired 2026-06-18 — a gemini row is ALWAYS a ghost (a stale profile
  // entry the hub faithfully reconciled), never a live seat. Hide it outright; the old
  // 24h-staleness rule let a fresh snapshot resurrect it (operator caught it 2026-08-30).
  if (e.provider === "gemini") return true;
  return snapshotTs > 0 && now - snapshotTs > ZOMBIE_HIDE_MS && e.kind === "subscription" && !e.plan;
}

// Brightness/tone class: ok = the VALUE reads at full text brightness; warn/fail carry the status
// tint. Muted stays reserved for the icon/label in the component.
export function toneClass(tone: ChipTone): string {
  if (tone === "warn") return "text-[var(--color-tr-warn)]";
  if (tone === "fail") return "text-[var(--color-tr-fail)]";
  return "text-[var(--color-tr-text)]";
}

// Chip order: Claude (windows) first, then prepaid $ rows, then quota rows, then plan rows.
const KIND_ORDER = { windows: 0, prepaid: 1, quota: 2, subscription: 3 } satisfies Record<string, number>;

export function sortRows(rows: BalanceRow[]): BalanceRow[] {
  return [...rows].sort((a, b) => (dictGet(KIND_ORDER, a.kind) ?? 4) - (dictGet(KIND_ORDER, b.kind) ?? 4));
}

export function chipFrom(e: BalanceRow, opts: ChipOpts = {}): BalanceChip | null {
  const now = opts.now ?? Date.now();
  const snap = opts.snapshotTs ?? 0;
  if (isZombie(e, snap, now)) return null;

  const brand = dictGet(BRAND, e.provider)
    ?? { mono: (e.label ?? e.provider).slice(0, 2).toUpperCase(), icon: null, hue: "#8A8A92", fg: "#1a1a1e" };
  const full = e.label ?? e.provider;
  let value = "?";
  let barPct: number | null = null;
  let tone: ChipTone = "ok";
  let detail: string;

  if (!e.ok) {
    detail = e.error ? `error: ${e.error}` : "unreachable";
    tone = "fail";
  } else if (e.kind === "windows") {
    const w = windowsInfo(e, now);
    value = w.value; barPct = w.barPct; tone = w.tone; detail = w.tooltip;
  } else if (e.kind === "quota") {
    const rs = resetShort(e.resetTime);
    if (e.remainingPct != null) {
      // The bar and the words agree with the windows rows: USED, counting up (Orca's read).
      const usedPct = Math.max(0, Math.min(100, 100 - Math.round(e.remainingPct)));
      const t = untilLong(e.resetTime, now);
      value = `${usedPct}% used${t ? ` ${t}` : ""}`;
      barPct = usedPct;
      detail = `${Math.round(e.remainingPct)}% left${rs ? ` · resets in ${rs}` : ""}`;
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
    key: e.provider, mono: brand.mono, icon: brand.icon, hue: brand.hue, fg: brand.fg,
    value, barPct, tone, stale, tooltip: `${full} · ${detail}${via}${staleLine}`,
  };
}

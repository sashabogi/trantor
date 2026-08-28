// Fleet balance chips — the pure formatting that turns a /balances row into the one chip that
// belongs in the app header: a short monogram + the single number that matters. All decision
// logic lives here so the strip component stays a dumb renderer and the drillable surface is the
// formatting itself. Semantics mirror lib/balances.mjs (symbols, reset short-forms, kind shapes)
// so the header and the CLI agree about what a row means.
import type { BalanceEntry } from "../../shared/api/client";
import { dictGet } from "../../shared/dict";

// The hub's /balances rows carry MORE than the client's conservative BalanceEntry declares: the
// fetch adapters spread the raw provider payload (usage/limit/resetTime/via/unlimited) into each
// entry before POSTing. The strip reads those extra fields, so the boundary cast widens once, in
// the component — never scattered through the formatter.
export type BalanceRow = BalanceEntry & {
  usage?: number | null;
  limit?: number | null;
  resetTime?: number | string | null;
  via?: string;
  unlimited?: boolean;
  detail?: string;
  error?: string;
};

export type BalanceChip = {
  key: string;
  label: string;   // the monogram, e.g. "OR", "DS", "GLM", "Kimi"
  value: string;   // the one number that matters, e.g. "$9.7", "89%", "plan"
  reset: string;   // optional reset suffix ("·1h") — the part that shrinks away on narrow windows
  low: boolean;
  tooltip: string; // full label, exact numbers, and the key source
};

// Crew providers have recognizable short forms. A closed, small table: a provider not in it is a
// provider the crew has never run, and its label's first letters stand in rather than us
// pretending to know a monogram.
const MONOGRAM = {
  openrouter: "OR",
  deepseek: "DS",
  moonshot: "MS",
  kimi: "Kimi",
  zai: "GLM",
  glm: "GLM",
  zhipu: "GLM",
  codex: "Codex",
  claude: "Claude",
  gemini: "Gem",
  anthropic: "Claude",
} as const satisfies Record<string, string>;

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

export function chipFrom(e: BalanceRow): BalanceChip {
  const label = dictGet(MONOGRAM, e.provider) ?? (e.label ?? e.provider).slice(0, 3).toUpperCase();
  const full = e.label ?? e.provider;
  let value = "?";
  let reset = "";
  let detail: string;
  if (!e.ok) {
    detail = e.error ? `error: ${e.error}` : "unreachable";
  } else if (e.kind === "quota") {
    const rs = resetShort(e.resetTime);
    reset = rs ? `·${rs}` : "";
    if (e.remainingPct != null) {
      const pct = Math.round(e.remainingPct);
      value = `${pct}%`;
      detail = `${pct}% left${rs ? ` · resets in ${rs}` : ""}`;
    } else {
      detail = "quota unknown";
    }
  } else if (e.kind === "subscription") {
    const p = (e.plan ?? "").trim();
    value = p ? "plan" : "sub";
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
  }
  const via = e.via ? ` · via ${e.via}` : "";
  return { key: e.provider, label, value, reset, low: e.low, tooltip: `${full} · ${detail}${via}` };
}

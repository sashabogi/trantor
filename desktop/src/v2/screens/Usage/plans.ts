// One plan card per provider from the /balances rows: honest meter, reset and pace (#13991).
import { chipFrom, isZombie, money, untilLong, epochMs, type BalanceRow } from "../../../features/fleet/balanceChips";
import { dictGet } from "../../../shared/dict";

export type PlanCard = {
  key: string; label: string; hue: string; kind: string;
  /** What the big line says: "14% of week", "$14.00 of $50", "no meter". */
  headline: string;
  /** Fill of the thin bar, or null when the provider gives no percentage. */
  pct: number | null;
  warn: boolean;
  noMeter: boolean;
  detail: string;
  /** The pace line, only when the window length and the reset are both known. */
  forecast: string | null;
};

const WINDOW_MS = { "5h": 5 * 3600e3, "7d": 7 * 86400e3 } as const satisfies Record<string, number>;
const WINDOW_WORD = { "5h": "5h window", "7d": "week" } as const satisfies Record<string, string>;
const NEAR_LIMIT_PCT = 75;
const MIN_ELAPSED = 0.03;

function span(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 90) return `${mins}m`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** Linear pace: assumes the rate so far continues. Null unless the window length is known. */
export function paceForecast(usedPct: number, resetsAt: number | string | null | undefined, windowName: string, now: number): string | null {
  const len = dictGet(WINDOW_MS, windowName);
  const reset = epochMs(resetsAt);
  if (!len || reset == null || reset <= now) return null;
  if (usedPct >= 100) return "limit reached until the reset";
  const elapsed = 1 - (reset - now) / len;
  if (elapsed < MIN_ELAPSED || elapsed > 1) return null;
  const projected = usedPct / elapsed;
  if (projected <= 100) return "lasts past the reset at this pace";
  const msToLimit = ((100 - usedPct) / usedPct) * elapsed * len;
  return `runs out in ~${span(msToLimit)} at this pace`;
}

const KIND_WORD = { windows: "subscription", quota: "quota", subscription: "subscription", prepaid: "API · metered" } as const satisfies Record<string, string>;

function withPlan(row: BalanceRow): string {
  const kind = dictGet(KIND_WORD, row.kind) ?? row.kind;
  return row.plan ? `${row.plan} · ${kind}` : kind;
}

function windowsCard(row: BalanceRow, now: number): Pick<PlanCard, "headline" | "pct" | "detail" | "forecast"> | null {
  const metered = (row.windows ?? []).filter(w => w && w.usedPct != null);
  if (!metered.length) return null;
  const worst = metered.reduce((a, b) => ((b.usedPct ?? 0) > (a.usedPct ?? 0) ? b : a));
  const pct = Math.round(worst.usedPct ?? 0);
  const until = worst.scoped ? null : untilLong(worst.resetsAt, now);
  const others = metered.filter(w => w !== worst).map(w => `${dictGet(WINDOW_WORD, w.name) ?? w.name} ${Math.round(w.usedPct ?? 0)}%`);
  const detail = [until ? `resets in ${until}` : null, ...others].filter(Boolean).join(" · ");
  const forecast = worst.scoped ? null : paceForecast(pct, worst.resetsAt, worst.name, now);
  return { headline: `${pct}% of ${dictGet(WINDOW_WORD, worst.name) ?? worst.name}`, pct, detail, forecast };
}

function prepaidCard(row: BalanceRow): Pick<PlanCard, "headline" | "pct" | "detail" | "forecast"> | null {
  if (row.unlimited) return { headline: "unlimited", pct: null, detail: "nothing to refill", forecast: null };
  if (row.remaining == null) return null;
  const cur = row.currency;
  if (row.usage != null && row.limit) {
    return { headline: `${money(row.usage, cur)} of ${money(row.limit, cur)}`, pct: Math.min(100, Math.round((row.usage / row.limit) * 100)), detail: "used against the cap set on the provider", forecast: null };
  }
  return { headline: money(row.remaining, cur), pct: null, detail: row.usage != null ? `prepaid balance · ${money(row.usage, cur)} used` : "prepaid balance", forecast: null };
}

export function planCards(rows: BalanceRow[], snapshotTs: number, now: number): PlanCard[] {
  const out: PlanCard[] = [];
  for (const row of rows) {
    const chip = chipFrom(row, { now, snapshotTs });
    if (!chip || isZombie(row, snapshotTs, now)) continue;
    const base = { key: row.provider, label: chip.label, hue: chip.hue, kind: withPlan(row) };
    if (!row.ok) {
      out.push({ ...base, headline: "unreachable", pct: null, warn: true, noMeter: false, detail: row.error ?? "the provider did not answer", forecast: null });
      continue;
    }
    const shown = row.kind === "windows" ? windowsCard(row, now)
      : row.kind === "quota" && row.remainingPct != null ? quotaCard(row, now)
      : row.kind === "prepaid" ? prepaidCard(row) : null;
    if (!shown) {
      out.push({ ...base, headline: "no meter", pct: null, warn: false, noMeter: true, detail: row.detail || "the provider exposes no usage", forecast: null });
      continue;
    }
    out.push({ ...base, ...shown, warn: row.low || (shown.pct ?? 0) >= NEAR_LIMIT_PCT, noMeter: false });
  }
  return out;
}

function quotaCard(row: BalanceRow, now: number): Pick<PlanCard, "headline" | "pct" | "detail" | "forecast"> {
  const pct = Math.max(0, Math.min(100, 100 - Math.round(row.remainingPct ?? 0)));
  const until = untilLong(row.resetTime, now);
  return { headline: `${pct}% of quota`, pct, detail: until ? `resets in ${until}` : "no reset time reported", forecast: null };
}

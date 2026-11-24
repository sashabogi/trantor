// KPI tiles with inline sparklines; a tile with no source is dropped, never filled in (#13991).
import { fmtInt, fmtMoney, fmtPct, fmtTokens } from "./format";
import type { AgentStat, DailyBar, EconPick } from "./model";

export type Kpi = { key: string; label: string; value: string; sub: string; spark: number[] | null; warn?: boolean };

export function Sparkline({ values }: { values: number[] }) {
  const w = 96, h = 24;
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(" ");
  return (
    <svg aria-hidden width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0">
      <polyline points={pts} fill="none" stroke="var(--v2-accent)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export type KpiInput = { stats: AgentStat[]; turnsDaily: DailyBar[]; failDaily: DailyBar[]; savedDaily: DailyBar[]; econ: EconPick; projectScoped: boolean };

export function buildKpis({ stats, turnsDaily, failDaily, savedDaily, econ, projectScoped }: KpiInput): Kpi[] {
  const turns = stats.reduce((s, a) => s + a.turns, 0);
  const failed = stats.reduce((s, a) => s + a.failures, 0);
  const scope = projectScoped ? " · all projects" : "";
  const na = "n/a at this range";
  const naSub = "the hub serves 24h, 7d, 30d and all-time windows";
  const out: Kpi[] = [
    { key: "turns", label: "TURNS", value: fmtInt(turns), sub: `across ${stats.length} agent${stats.length === 1 ? "" : "s"}`, spark: turnsDaily.map(d => d.total) },
    { key: "wasted", label: "WASTED TURNS", value: fmtInt(failed), sub: `${fmtPct(failed, turns)} of turns exited non-zero`, spark: failDaily.map(d => d.total), warn: turns > 0 && failed / turns >= 0.15 },
    econ.available
      ? { key: "tokens", label: "SCROOGE TOKENS", value: fmtTokens(econ.tokens), sub: `metered one-shots only · ${econ.label}${scope}`, spark: null }
      : { key: "tokens", label: "SCROOGE TOKENS", value: na, sub: naSub, spark: null },
    econ.available
      ? { key: "spend", label: "REAL SPEND", value: fmtMoney(econ.cost), sub: `metered only: scrooge ledger · ${econ.label}${scope}`, spark: null }
      : { key: "spend", label: "REAL SPEND", value: na, sub: naSub, spark: null },
  ];
  if (econ.apiValue != null) {
    out.push({ key: "api", label: "API VALUE", value: fmtMoney(econ.apiValue), sub: `plan-covered Claude work at list prices* · ${econ.label}${scope}`, spark: null });
  }
  out.push(econ.available
    ? { key: "saved", label: "SAVED VS ALL-FRONTIER", value: fmtMoney(econ.saved), sub: `had every scrooge call run on Opus · ${econ.label}${scope}`, spark: savedDaily.some(d => d.total > 0) ? savedDaily.map(d => d.total) : null }
    : { key: "saved", label: "SAVED VS ALL-FRONTIER", value: na, sub: naSub, spark: null });
  return out;
}

export function KpiRow({ kpis }: { kpis: Kpi[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-[10px]">
      {kpis.map(k => (
        <div key={k.key} data-kpi={k.key} className="flex flex-col gap-1 rounded-xl border border-[var(--v2-edge)] bg-[var(--v2-panel)] px-[14px] py-3">
          <span className="text-[10.5px] font-semibold tracking-[0.08em] text-[var(--v2-muted)]">{k.label}</span>
          <div className="flex items-end justify-between gap-2">
            <span className={`text-[22px] font-semibold leading-tight ${k.warn ? "text-[var(--v2-warn)]" : k.value.startsWith("n/a") ? "text-[var(--v2-muted)] text-[15px]" : ""}`}>{k.value}</span>
            {k.spark && k.spark.length > 1 && <Sparkline values={k.spark} />}
          </div>
          <span className="text-[11px] text-[var(--v2-muted)]">{k.sub}</span>
        </div>
      ))}
    </div>
  );
}

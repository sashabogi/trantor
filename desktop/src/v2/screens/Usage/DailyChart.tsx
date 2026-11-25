// Daily stacked bars by vendor, with a table view of the same numbers (#13991).
import { useState } from "react";
import { Seg, Section } from "../../index";
import { modelHue } from "../../ui/identity";
import { fmtInt, fmtMoney } from "./format";
import { VENDORS, type DailyBar, type Vendor } from "./model";

export type Metric = "turns" | "saved";
const METRIC_LABEL = { turns: "Turns", saved: "Saved $" } as const satisfies Record<Metric, string>;
const fmtMetric = (m: Metric, n: number): string => (m === "saved" ? fmtMoney(n) : fmtInt(n));
const shortDay = (day: string): string => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export type DailyChartProps = {
  bars: Record<Metric, DailyBar[]>;
  available: Metric[];
  rangeLabel: string;
  vendor: Vendor | null;
  onVendor: (v: Vendor | null) => void;
};

function Bars({ bars, metric }: { bars: DailyBar[]; metric: Metric }) {
  const max = Math.max(...bars.map(b => b.total), 0);
  const every = Math.max(1, Math.ceil(bars.length / 14));
  return (
    <div role="img" aria-label={`Daily ${METRIC_LABEL[metric]} by vendor`} className="flex h-[150px] items-end gap-[3px]">
      {bars.map((b, i) => (
        <div key={b.day} data-day={b.day} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
          <div className="flex w-full flex-col-reverse overflow-hidden rounded-sm" style={{ height: `${max ? (b.total / max) * 100 : 0}%`, minHeight: b.total > 0 ? 2 : 0 }}
            title={`${shortDay(b.day)}: ${fmtMetric(metric, b.total)}`}>
            {VENDORS.filter(v => b.byVendor[v] > 0).map(v => (
              <span key={v} title={`${v}: ${fmtMetric(metric, b.byVendor[v])}`} style={{ height: `${(b.byVendor[v] / b.total) * 100}%`, background: modelHue(v) }} />
            ))}
          </div>
          <span className="h-3 text-v2-micro text-[var(--v2-muted)]">{i % every === 0 ? shortDay(b.day) : ""}</span>
        </div>
      ))}
    </div>
  );
}

function DayTable({ bars, metric, vendors }: { bars: DailyBar[]; metric: Metric; vendors: Vendor[] }) {
  return (
    <div className="max-h-[260px] overflow-auto">
      <table className="w-full border-collapse text-v2-body">
        <thead><tr className="text-left text-v2-small tracking-[0.06em] text-[var(--v2-muted)]">
          <th className="py-1 pr-3 font-semibold">DAY</th>
          {vendors.map(v => <th key={v} className="px-2 py-1 text-right font-semibold">{v.toUpperCase()}</th>)}
          <th className="px-2 py-1 text-right font-semibold">TOTAL</th>
        </tr></thead>
        <tbody>{bars.map(b => (
          <tr key={b.day} className="border-t border-[var(--v2-edge)]">
            <td className="py-1 pr-3">{b.day}</td>
            {vendors.map(v => <td key={v} className="px-2 py-1 text-right tabular-nums">{b.byVendor[v] ? fmtMetric(metric, b.byVendor[v]) : "·"}</td>)}
            <td className="px-2 py-1 text-right font-medium tabular-nums">{fmtMetric(metric, b.total)}</td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}

export function DailyChart({ bars, available, rangeLabel, vendor, onVendor }: DailyChartProps) {
  const [chosen, setChosen] = useState<Metric>("turns");
  const [asTable, setAsTable] = useState(false);
  const metric = available.includes(chosen) ? chosen : available[0];
  if (!metric) {
    return <Section title="DAILY USAGE" sub={rangeLabel}><p className="m-0 text-v2-body text-[var(--v2-muted)]">The hub has no per-day series yet.</p></Section>;
  }
  const rows = bars[metric];
  const present = VENDORS.filter(v => rows.some(b => b.byVendor[v] > 0));
  return (
    <Section title="DAILY USAGE" sub={`${rangeLabel} · UTC days · click a vendor to filter`}
      actions={<>
        <Seg label="Metric" value={metric} onChange={setChosen} options={available.map(m => ({ value: m, label: METRIC_LABEL[m] }))} />
        <button type="button" aria-pressed={asTable} onClick={() => setAsTable(t => !t)} className="rounded-md border-0 bg-transparent px-2 py-1 text-v2-body text-[var(--v2-accent)] hover:text-[var(--v2-accent-hi)]">
          {asTable ? "View as chart" : "View as table"}
        </button>
      </>}>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-v2-body text-[var(--v2-text-2)]">
        {present.map(v => (
          <button key={v} type="button" aria-pressed={vendor === v} onClick={() => onVendor(vendor === v ? null : v)}
            className={`inline-flex items-center gap-[5px] rounded-md border-0 px-1.5 py-0.5 ${vendor === v ? "bg-[var(--v2-hover)]" : "bg-transparent"}`}>
            <span aria-hidden className="size-2 rounded-full" style={{ background: modelHue(v) }} />{v}
          </button>
        ))}
        {present.length === 0 && <span className="text-[var(--v2-muted)]">nothing recorded in this range</span>}
      </div>
      {asTable ? <DayTable bars={rows} metric={metric} vendors={present} /> : <Bars bars={rows} metric={metric} />}
    </Section>
  );
}

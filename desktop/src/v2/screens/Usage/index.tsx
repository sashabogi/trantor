// Usage and costs: plans, spend, turns and outcomes from real hub reads (#13991).
import { useMemo, useState } from "react";
import { Button, NotWired, Seg, type ScreenProps } from "../../index";
import type { BalanceRow } from "../../../features/fleet/balanceChips";
import { useBalances } from "../../shell/useBalances";
import { DailyChart, type Metric } from "./DailyChart";
import { CachePanel, WastedPanel } from "./Insights";
import { buildKpis, KpiRow } from "./Kpis";
import { PlansPanel } from "./PlansPanel";
import { AgentTable, CardTable, ProjectTable } from "./Tables";
import { downloadCsv, toCsv } from "./format";
import {
  agentRows, agentStats, barDays, cardRows, dailyFailures, dailySaved, dailyTurns, earliestDay, econFor, filterAgents,
  NO_FILTERS, projectRows, rangeWindow, RANGES, scopeFor, type Filters, type RangeKey, type Scope,
} from "./model";
import { planCards } from "./plans";
import { agentTable, cardTable, projectTable } from "./tableData";
import { dataOf, useUsageData } from "./useUsageData";

const FILTER_KEYS = ["project", "vendor", "agent"] as const;
const EMPTY_SCOPE: Scope = { agents: [], models: [] };

function FilterBar({ filters, onChange, onExport }: { filters: Filters; onChange: (f: Filters) => void; onExport: () => void }) {
  const active = FILTER_KEYS.map(k => [k, filters[k]] as const).filter(([, v]) => v);
  return (
    <div className="flex flex-wrap items-center gap-2 text-v2-body text-[var(--v2-muted)]">
      <span className="text-v2-small font-semibold tracking-[0.08em]">FILTERS</span>
      {active.map(([k, v]) => (
        <span key={k} data-filter={k} className="inline-flex items-center gap-[5px] whitespace-nowrap rounded-full border border-[var(--v2-accent-edge)] bg-[var(--v2-accent-soft)] px-[9px] py-0.5 text-v2-body text-[var(--v2-accent-hi)]">
          {k}: {v}
          <button type="button" aria-label={`Remove filter ${k}: ${v}`} title={`Remove filter ${k}`} onClick={() => onChange({ ...filters, [k]: null })}
            className="border-0 bg-transparent p-0 text-[var(--v2-accent-hi)]">×</button>
        </span>
      ))}
      {active.length === 0 && <span>none · click a project, agent or vendor to filter</span>}
      <span className="flex-1" />
      <Button onClick={onExport}>Export all</Button>
    </div>
  );
}

function Header({ range, onRange }: { range: RangeKey; onRange: (r: RangeKey) => void }) {
  return (
    <div className="flex flex-wrap items-end gap-[14px]">
      <div className="min-w-[280px] flex-1">
        <div className="text-v2-small font-semibold tracking-[0.1em] text-[var(--v2-brand-claude)]">READ FROM THE HUB'S TURN LOG, THE SCROOGE LEDGER AND EACH PROVIDER'S OWN METER</div>
        <h1 className="m-0 mt-1 text-v2-display font-[650] tracking-[-0.01em]">Usage and costs</h1>
      </div>
      <Seg label="Range" value={range} onChange={onRange} options={RANGES} />
    </div>
  );
}

export function UsageScreen({ client }: ScreenProps) {
  const [range, setRange] = useState<RangeKey>("14d");
  // #13984 drill: opening scoped to the active project read zero for a project with no turns; start fleet-wide.
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const balances = useBalances(client);
  const data = useUsageData(client);
  const now = Date.now();
  const w = rangeWindow(range, now);
  const learning = dataOf(data.learning);
  const economics = dataOf(data.economics);
  const tasks = dataOf(data.tasks) ?? [];
  // SAFETY: /balances entries carry provider fields the frozen BalanceEntry omits; classic casts the same way.
  const rows = useMemo(() => (balances.report?.entries ?? []) as BalanceRow[], [balances.report]);
  const cards = planCards(rows, balances.report?.ts ?? 0, now);

  const scope = learning ? scopeFor(learning, filters.project) : EMPTY_SCOPE;
  const stats = filterAgents(agentStats(scope.agents, w), filters);
  const days = barDays(w, earliestDay(scope.agents));
  const savedBars = dailySaved(scope.models, days, filters.vendor);
  const bars = { turns: dailyTurns(stats, days), saved: savedBars };
  const available: Metric[] = learning ? (savedBars.some(b => b.total > 0) ? ["turns", "saved"] : ["turns"]) : [];
  const econ = econFor(range, economics);
  const agents = agentRows(stats, tasks, dataOf(data.peers) ?? [], w);
  const cardList = cardRows(tasks, w, filters);
  const projects = learning ? projectRows(learning, economics, w, { ...filters, project: null }) : [];
  const rangeLabel = RANGES.find(r => r.value === range)?.label ?? "";

  const exportAll = () => {
    const parts = [agentTable(agents), cardTable(cardList), projectTable(projects)];
    downloadCsv("usage-all.csv", parts.map(p => toCsv(p.head, p.rows)).join("\n"));
  };
  const kpis = buildKpis({ stats, turnsDaily: bars.turns, failDaily: dailyFailures(stats, days), savedDaily: savedBars, econ, projectScoped: !!filters.project });
  const hasTurns = bars.turns.some(day => day.total > 0);
  const lastRowTs = dataOf(data.health)?.telemetry?.lastRowTs ?? 0;

  return (
    <div data-screen="usage" className="flex min-h-full flex-col gap-[14px] overflow-y-auto px-6 pb-6 pt-[18px]">
      <Header range={range} onRange={setRange} />
      <FilterBar filters={filters} onChange={setFilters} onExport={exportAll} />
      <PlansPanel cards={cards} failure={balances.failure} loading={!balances.report && !balances.failure} />
      {learning ? (
        <>
          <KpiRow kpis={kpis} />
          {!hasTurns && (
            <p data-empty-turns className="m-0 rounded-lg border border-[var(--v2-accent-edge)] bg-[var(--v2-panel)] px-4 py-3 text-v2-body text-[var(--v2-muted)]">
              No turns in this range. {lastRowTs
                ? `The last turn was reported ${new Date(lastRowTs).toLocaleString()}.`
                : "No runner has reported a turn to this hub."}
            </p>
          )}
          <DailyChart bars={bars} available={available} rangeLabel={rangeLabel} vendor={filters.vendor} onVendor={vendor => setFilters({ ...filters, vendor })} />
          <AgentTable rows={agents} agent={filters.agent} onAgent={agent => setFilters({ ...filters, agent })} />
          <div className="grid grid-cols-[repeat(auto-fit,minmax(380px,1fr))] gap-[14px]">
            <CardTable rows={cardList} />
            <ProjectTable rows={projects} project={filters.project} onProject={p => setFilters({ ...filters, project: p })} />
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-[14px]">
            <WastedPanel stats={stats} />
            <CachePanel rows={rows} />
          </div>
        </>
      ) : (
        <NotWired title="Turn log unavailable" line={data.learning.state === "failed" ? `The hub did not serve /learning: ${data.learning.error}` : "Reading the hub's turn log..."} />
      )}
      <Footnote updatedAt={data.updatedAt} onRescan={() => { data.reload(); balances.refetch(); }} />
    </div>
  );
}

function Footnote({ updatedAt, onRescan }: { updatedAt: number; onRescan: () => void }) {
  const mins = updatedAt ? Math.max(0, Math.round((Date.now() - updatedAt) / 60000)) : null;
  return (
    <p className="m-0 text-v2-body leading-[1.5] text-[var(--v2-muted)]">
      * API value is what plan-covered usage would cost at list prices; subscriptions are not billed per token. Real spend is what the metered
      Scrooge ledger charged. Providers with no meter show no meter, never a guess. Economics are fleet-wide rolling windows (24h, 7d, 30d, all time);
      turns come from the hub's per-day turn log in UTC days. {mins == null ? "Loading..." : `Updated ${mins === 0 ? "just now" : `${mins} min ago`}.`}{" "}
      <button type="button" onClick={onRescan} className="border-0 bg-transparent p-0 text-[var(--v2-accent)] hover:text-[var(--v2-accent-hi)]">Rescan</button>
    </p>
  );
}

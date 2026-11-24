// The plans-and-balances footer in 2.0 chrome. Chip text, tones and staleness come from classic
// balanceChips so the two bars can never disagree (#v2-F).
import { RefreshCw, Server } from "lucide-react";
import type { BalancesReport, HubClient, MachinesHealthReport } from "../../shared/api/client";
import { chipFrom, isStale, isZombie, sortRows, type BalanceChip, type BalanceRow } from "../../features/fleet/balanceChips";
import { BrandMark } from "../../features/fleet/BrandMark";
import { machineHealthLine, machineStale, useMachinesHealth } from "../../features/fleet/MachineHealth";
import { IconButton } from "../ui/IconButton";
import { useBalances } from "./useBalances";

const CHIP_TONE = {
  ok: { bg: "var(--v2-panel-2)", border: "var(--v2-edge)", value: "var(--v2-muted)", bar: "" },
  warn: { bg: "var(--v2-warn-soft)", border: "var(--v2-warn-edge)", value: "var(--v2-warn)", bar: "var(--v2-warn)" },
  fail: { bg: "var(--v2-bad-soft)", border: "#4A2A2A", value: "var(--v2-bad)", bar: "var(--v2-bad)" },
} as const;

export function balanceChips(report: BalancesReport | null): BalanceChip[] {
  // SAFETY: /balances entries carry provider fields the narrow BalanceEntry type omits; classic decodes the same way.
  const rows = (report?.entries ?? []) as BalanceRow[];
  const ts = report?.ts ?? 0;
  return sortRows(rows.filter(e => !isZombie(e, ts)))
    .map(e => chipFrom(e, { snapshotTs: ts }))
    .filter((c): c is BalanceChip => c != null);
}

function PlanChip({ chip, onOpen }: { chip: BalanceChip; onOpen: () => void }) {
  const t = CHIP_TONE[chip.tone];
  return (
    <button type="button" onClick={onOpen} title={`${chip.tooltip}. Open Usage and costs`} data-chip={chip.key}
      className="inline-flex shrink-0 items-center gap-[7px] rounded-lg px-[9px] py-1 text-[11.5px] font-medium text-[var(--v2-text)]"
      style={{ background: t.bg, border: `1px solid ${t.border}`, opacity: chip.stale ? 0.6 : 1 }}>
      <BrandMark icon={chip.icon} mono={chip.mono} hue={chip.hue} fg={chip.fg} />
      {chip.label}
      {chip.barPct != null && (
        <span className="inline-block h-1 w-10 rounded-sm bg-[var(--v2-edge-2)]">
          <span className="block h-1 rounded-sm" style={{ width: `${Math.min(100, chip.barPct)}%`, background: t.bar || chip.hue }} />
        </span>
      )}
      <span className="v2-mono whitespace-nowrap" style={{ color: t.value }}>{chip.value}</span>
    </button>
  );
}

function Machines({ report }: { report: MachinesHealthReport | null }) {
  return (
    <>
      {(report?.machines ?? []).map(m => {
        const stale = machineStale(m, report?.staleAfterMs);
        return (
          <span key={m.machine} data-machine={m.machine} title={stale ? `${m.machine} unreachable: no recent heartbeat` : `${m.machine}: load over cores; memory used of total`}
            className="inline-flex shrink-0 items-center gap-1.5" style={{ opacity: stale ? 0.45 : 1 }}>
            <Server size={12} aria-hidden />{m.machine}
            <span className="v2-mono">{machineHealthLine(m)}{stale ? " · stale" : ""}</span>
          </span>
        );
      })}
    </>
  );
}

export type PlansBarProps = {
  report: BalancesReport | null;
  failure: string | null;
  machines: MachinesHealthReport | null;
  spinning: boolean;
  onRefresh: () => void;
  onOpenUsage: () => void;
};

/** Pure: the tests feed reports straight in. */
export function PlansBar({ report, failure, machines, spinning, onRefresh, onOpenUsage }: PlansBarProps) {
  const chips = balanceChips(report);
  const dim = failure !== null || (report != null && isStale(report.ts));
  const hub = failure !== null ? { color: "var(--v2-bad)", text: "hub unreachable" }
    : report ? { color: "var(--v2-ok)", text: "hub connected" } : { color: "var(--v2-track)", text: "connecting" };
  return (
    <footer aria-label="Plans and balances"
      className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto border-t border-[var(--v2-edge)] bg-[var(--v2-chrome)] px-3 text-[11.5px] text-[var(--v2-muted)]">
      <div className="flex min-w-0 items-center gap-2" style={{ opacity: dim ? 0.55 : 1 }}>
        {failure !== null && <span role="status" className="v2-mono shrink-0 whitespace-nowrap">usage unavailable: {failure}</span>}
        {!chips.length && failure === null && <span className="shrink-0">{report ? "No plans reported yet" : "Reading plans"}</span>}
        {chips.map(c => <PlanChip key={c.key} chip={c} onOpen={onOpenUsage} />)}
      </div>
      <IconButton label="Refresh plans and balances" title="Re-query every provider now" size={24} onClick={onRefresh}>
        <RefreshCw size={11} aria-hidden className={spinning ? "animate-spin" : undefined} />
      </IconButton>
      <span className="ml-auto flex shrink-0 items-center gap-3">
        <Machines report={machines} />
        <span className="inline-flex items-center gap-1.5" title={failure ?? undefined}>
          <span aria-hidden className="h-[7px] w-[7px] rounded-full" style={{ background: hub.color }} />{hub.text}
        </span>
      </span>
    </footer>
  );
}

export function BottomBar({ client, onOpenUsage }: { client: HubClient; onOpenUsage: () => void }) {
  const { report, failure, spinning, refetch } = useBalances(client);
  const machines = useMachinesHealth(client);
  return <PlansBar report={report} failure={failure} machines={machines} spinning={spinning} onRefresh={refetch} onOpenUsage={onOpenUsage} />;
}

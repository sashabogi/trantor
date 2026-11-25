// The plans-and-balances footer in 2.0 chrome. Chip text, tones and staleness come from classic
// balanceChips so the two bars can never disagree (#v2-F).
import { RefreshCw, Server } from "lucide-react";
import type { BalancesReport, HubClient, MachinesHealthReport } from "../../shared/api/client";
import { agoLabel, chipFrom, isStale, isZombie, sortRows, type BalanceChip, type BalanceRow } from "../../features/fleet/balanceChips";
import { BrandMark } from "../../features/fleet/BrandMark";
import { machineHealthLine, machineStale, useMachinesHealth } from "../../features/fleet/MachineHealth";
import { IconButton } from "../ui/IconButton";
import { useBalances } from "./useBalances";

const CHIP_TONE = {
  ok: { bg: "var(--v2-panel-2)", border: "var(--v2-edge)", value: "var(--v2-muted)", bar: "" },
  warn: { bg: "var(--v2-warn-soft)", border: "var(--v2-warn-edge)", value: "var(--v2-warn)", bar: "var(--v2-warn)" },
  fail: { bg: "var(--v2-bad-soft)", border: "var(--v2-bad-edge)", value: "var(--v2-bad)", bar: "var(--v2-bad)" },
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

// A long refresh error must not blow out the footer: the visible line is bounded, the tooltip
// keeps the whole message (#14055).
const CLIP = 100;
function clipLine(s: string): string {
  const one = s.trim().split("\n")[0] ?? "";
  return one.length > CLIP ? `${one.slice(0, CLIP - 1)}…` : one;
}

export type PlansBarProps = {
  report: BalancesReport | null;
  failure: string | null;
  refreshError: string | null;
  machines: MachinesHealthReport | null;
  spinning: boolean;
  onRefresh: () => void;
  onOpenUsage: () => void;
};

/** Pure: the tests feed reports straight in. */
export function PlansBar({ report, failure, refreshError, machines, spinning, onRefresh, onOpenUsage }: PlansBarProps) {
  const chips = balanceChips(report);
  const dim = failure !== null || (report != null && isStale(report.ts));
  // #14055 — dimming alone never said WHY: the snapshot age (or the refresh error) rides beside
  // the chips and in the tooltip, not only inside each chip's own staleness line.
  const asOf = report != null && isStale(report.ts) ? `as of ${agoLabel(Date.now() - report.ts)} ago` : null;
  const why = refreshError != null
    ? {
        text: `refresh failed: ${clipLine(refreshError)}`,
        title: `Last provider refresh failed: ${refreshError}${asOf ? `\nPlans snapshot ${asOf}.` : ""}`,
      }
    : asOf != null
      ? { text: asOf, title: `Plans snapshot ${asOf} — the chips stay dim until a fresh refresh lands.` }
      : null;
  const hub = failure !== null ? { color: "var(--v2-bad)", text: "hub unreachable" }
    : report ? { color: "var(--v2-ok)", text: "hub connected" } : { color: "var(--v2-track)", text: "connecting" };
  return (
    <footer aria-label="Plans and balances"
      className="flex h-10 shrink-0 items-center gap-2 overflow-hidden border-t border-[var(--v2-edge)] bg-[var(--v2-chrome)] px-3 text-[11.5px] text-[var(--v2-muted)]">
      {/* #13984 drill: at 1440px the chips ran under the machine readout; they scroll in their own lane instead. */}
      <div data-bar-chips className="v2-no-scrollbar flex items-center gap-2 whitespace-nowrap"
        style={{ opacity: dim ? 0.55 : 1, minWidth: 0, flex: "0 1 auto", overflowX: "auto", flexWrap: "nowrap", scrollbarWidth: "none" }}>
        {failure !== null && <span role="status" className="v2-mono shrink-0 whitespace-nowrap">usage unavailable: {failure}</span>}
        {!chips.length && failure === null && <span className="shrink-0">{report ? "No plans reported yet" : "Reading plans"}</span>}
        {chips.map(c => <PlanChip key={c.key} chip={c} onOpen={onOpenUsage} />)}
      </div>
      {why != null && (
        <span data-bar-why className="v2-mono shrink-0 whitespace-nowrap" style={{ color: "var(--v2-warn)" }} title={why.title}>
          {why.text}
        </span>
      )}
      <IconButton label="Refresh plans and balances" title="Re-query every provider now" size={24} onClick={onRefresh}>
        <RefreshCw size={11} aria-hidden className={spinning ? "animate-spin" : undefined} />
      </IconButton>
      <span data-bar-machines className="ml-auto flex items-center gap-3" style={{ flex: "none" }}>
        <Machines report={machines} />
        <span className="inline-flex items-center gap-1.5" title={failure ?? undefined}>
          <span aria-hidden className="h-[7px] w-[7px] rounded-full" style={{ background: hub.color }} />{hub.text}
        </span>
      </span>
    </footer>
  );
}

export function BottomBar({ client, onOpenUsage }: { client: HubClient; onOpenUsage: () => void }) {
  const { report, failure, refreshError, spinning, refetch } = useBalances(client);
  const machines = useMachinesHealth(client);
  return <PlansBar report={report} failure={failure} refreshError={refreshError} machines={machines} spinning={spinning} onRefresh={refetch} onOpenUsage={onOpenUsage} />;
}

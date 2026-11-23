// #13920: live CPU/memory per seat-hosting machine, in the fleet bar beside the seat counts.
// Monitoring doctrine — STATE, not events: the hub keeps the latest beat per machine, and the
// greyed "stale" mark IS the honest "unreachable" signal (no alerts). No reporting machine, no
// segment. Memory renders as GB = GiB-rounded used/total, like every system monitor.
import { useCallback, useEffect, useState } from "react";
import { HubClient, type MachineHealthRow, type MachinesHealthReport } from "../../shared/api/client";

const LOCAL_HUB = "http://127.0.0.1:4477";
// The runner beats every ~30s; a beat plus this poll keeps the bar within ~30s of a load change.
const REFRESH_MS = 10_000;

const GiB = 2 ** 30;
const gb = (bytes: number) => Math.round(bytes / GiB);

export function machineStale(m: MachineHealthRow, staleAfterMs: number | undefined, now = Date.now()): boolean {
  return now - m.ts > (staleAfterMs || 90_000);
}

export function machineHealthLine(m: MachineHealthRow): string {
  return `CPU ${Math.round(m.cpuPct)}% · ${gb(m.memUsed)}/${gb(m.memTotal)} GB`;
}

/** The bar segment: one greyed, marked row per machine. Pure — the tests feed rows directly. */
export function MachineHealthRows({ report }: { report: MachinesHealthReport | null }) {
  const rows = report?.machines ?? [];
  if (!rows.length) return null;
  return (
    <>
      {rows.map(m => {
        const stale = machineStale(m, report?.staleAfterMs);
        const age = Math.max(0, Math.round((Date.now() - m.ts) / 1000));
        return (
          <span key={m.machine} data-machine={m.machine}
            title={stale
              ? `${m.machine} unreachable — no heartbeat for ${age}s (stale past ${Math.round((report?.staleAfterMs || 90_000) / 1000)}s)`
              : `${m.machine} — 1-min load over cores; memory used of total`}
            className={`flex shrink-0 items-center gap-1.5 text-[10.5px] ${stale ? "opacity-45" : ""}`}>
            <span className="shrink-0 whitespace-nowrap text-[var(--color-tr-muted)]">{m.machine}</span>
            <span className="tr-mono whitespace-nowrap">{machineHealthLine(m)}{stale ? " · stale" : ""}</span>
          </span>
        );
      })}
    </>
  );
}

/** Latest beats from the app's hub (local hub as fallback), refreshed often enough that a load
 * change shows within ~30s. A failed fetch keeps the last report; staleness is recomputed on a
 * local tick so a silent hub flips the marker without new data. */
export function useMachinesHealth(client: HubClient): MachinesHealthReport | null {
  const [report, setReport] = useState<MachinesHealthReport | null>(null);
  // The clock tick re-renders on the same cadence even when the fetch keeps failing, so a silent
  // hub still flips `stale` on time — staleness must never wait for fresh data to stop arriving.
  const [, setClock] = useState(0);
  const isLocal = client.baseUrl.includes("127.0.0.1") || client.baseUrl.includes("localhost");
  const pull = useCallback(async () => {
    const read = isLocal
      ? client.machinesHealth()
      : client.machinesHealth().catch(() => new HubClient(LOCAL_HUB).machinesHealth());
    await read.then(r => { setReport(r); }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);
  useEffect(() => {
    let alive = true;
    const tick = () => { if (!alive) return; void pull(); setClock(c => c + 1); };
    void pull();
    const t = setInterval(tick, REFRESH_MS);
    return () => { alive = false; clearInterval(t); };
  }, [pull]);
  return report;
}

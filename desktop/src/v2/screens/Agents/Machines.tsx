// Machines (CPU and memory from the health heartbeat, seat avatars) and Elsewhere (#13992).
import { machineHealthLine, machineStale } from "../../../features/fleet/MachineHealth";
import type { MachinesHealthReport } from "../../../shared/api/client";
import { ago } from "../../../shared/presence";
import { Avatar, seatLabel } from "../../index";
import type { SeatView } from "./model";

export const SECTION_LABEL = "text-v2-small font-semibold uppercase tracking-[0.06em] text-[var(--v2-muted)]";

function Gauge({ label, pct }: { label: string; pct: number }) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div className="flex items-center gap-2 text-v2-small text-[var(--v2-muted)]">
      <span className="w-12">{label}</span>
      <span role="meter" aria-label={label} aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--v2-track)]">
        <span className="block h-full" style={{ width: `${p}%`, background: p >= 85 ? "var(--v2-warn)" : "var(--v2-accent)" }} />
      </span>
      <span className="v2-mono w-9 text-right text-[var(--v2-text-2)]">{p}%</span>
    </div>
  );
}

export function Machines({ report, views }: { report: MachinesHealthReport | null; views: SeatView[] }) {
  const rows = report?.machines ?? [];
  if (!rows.length) return <p className="m-0 text-v2-body text-[var(--v2-muted)]">No machine is reporting health yet.</p>;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2.5">
      {rows.map(m => {
        const stale = machineStale(m, report?.staleAfterMs);
        const seats = views.filter(v => v.presence !== "offline" && v.peer.machine?.toLowerCase() === m.machine.toLowerCase());
        return (
          <div key={m.machine} data-machine={m.machine} className={`rounded-xl border border-[var(--v2-edge)] bg-[var(--v2-panel)] p-3 ${stale ? "opacity-55" : ""}`}>
            <div className="flex items-center gap-2">
              <span className="flex-1 text-v2-base font-semibold">{m.machine}{stale ? " · stale" : ""}</span>
              <span className="flex -space-x-1">{seats.map(v => <Avatar key={v.peer.session} name={v.peer.session} size={18} surface="var(--v2-panel)" />)}</span>
            </div>
            <div className="mt-2 flex flex-col gap-1.5">
              <Gauge label="CPU" pct={m.cpuPct} />
              <Gauge label="memory" pct={m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0} />
            </div>
            <div className="mt-1.5 text-v2-small text-[var(--v2-muted)]">{machineHealthLine(m)} · beat {ago(m.ts)} ago</div>
          </div>
        );
      })}
    </div>
  );
}

export function Elsewhere({ views }: { views: SeatView[] }) {
  if (!views.length) return <p className="m-0 text-v2-body text-[var(--v2-muted)]">No seats in other projects.</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
      {views.map(v => (
        <li key={v.peer.session} className="flex items-center gap-2.5 rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel)] px-2.5 py-1.5 text-v2-body">
          <Avatar name={v.peer.session} size={22} presence={v.presence} surface="var(--v2-panel)" />
          <span className="font-medium">{seatLabel(v.peer.session)}</span>
          <span className="text-[var(--v2-muted)]">{v.project || "no project"}</span>
          <span className="flex-1" />
          <span className="text-[var(--v2-muted)]">{v.presence === "working" ? "working" : v.presence === "needs-you" ? "needs you" : "idle"} {ago(v.peer.lastSeen)}</span>
        </li>
      ))}
    </ul>
  );
}

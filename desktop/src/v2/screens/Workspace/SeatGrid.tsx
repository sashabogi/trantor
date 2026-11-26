// Split and Grid: several seats' live terminals at once; click a tile's header to focus that seat (#13987).
// #14351: tiles share the tabs' language: radius 8, 1px edge, one terminal ground, a 32px header with the compact astronaut (#14365), the name and what it is doing.
import type { ReactNode } from "react";
import { Maximize2 } from "lucide-react";
import { activityLine, seatState } from "../../ui/identity";
import { SeatAstronaut } from "../../ui/SeatAstronaut";
import { useActivePane } from "../../ui/useActivePane";
import { AgentDot } from "./AgentDot";
import { SeatPane } from "./WorkArea";
import { gridColumns, type Layout, type SeatView } from "./seatModel";

function SeatTile({ seat, selected, children }: { seat: SeatView; selected: boolean; children: ReactNode }) {
  const pane = useActivePane(seat.presence === "working");
  return <div {...pane} data-selected={selected || undefined} data-needs={seat.presence === "needs-you" || undefined}
    className={`group/tile flex min-h-[240px] min-w-0 flex-col overflow-hidden rounded-lg bg-[var(--v2-terminal)] ${seat.presence === "needs-you" ? "!border-[var(--v2-warn)]" : ""}`}>{children}</div>;
}

export function SeatGrid({ project, seats, layout, selectedKey, onFocus, needs }: {
  project: string; seats: SeatView[]; layout: Layout; selectedKey: string | undefined; onFocus: (key: string) => void;
  /** What each seat is waiting on you for, by seat key. */
  needs: Record<string, string>;
}) {
  const cols = layout === "split" ? Math.min(2, Math.max(1, seats.length)) : gridColumns(seats.length);
  if (!seats.length) {
    return <div className="m-5 rounded-xl border border-dashed border-[var(--v2-edge-2)] p-6 text-center text-v2-base text-[var(--v2-muted)]">No live seat to show. Add a seat above.</div>;
  }
  return (
    <div className="m-1.5 grid min-h-0 flex-1 gap-1.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {seats.map(s => (
        <SeatTile key={s.key} seat={s} selected={s.key === selectedKey}>
          <button type="button" onClick={() => onFocus(s.key)} title={`Open ${s.label} full size`}
            className="flex h-8 shrink-0 items-center gap-2 border-0 border-b border-[var(--v2-edge)] bg-transparent px-2.5 text-left text-v2-body text-[var(--v2-text)]">
            {s.agentInfo ? <AgentDot running={s.agentInfo.state === "running"} /> : <SeatAstronaut vendor={s.brand} name={s.label} state={seatState(s)} size={24} variant="compact" surface="var(--v2-terminal)" />}
            <span className="font-semibold">{s.label}</span>
            <span className="min-w-0 flex-1 truncate text-v2-small" style={{ color: s.presence === "needs-you" ? "var(--v2-warn)" : "var(--v2-muted)" }}>{activityLine(s, { needs: needs[s.key] })}</span>
            <Maximize2 size={11} aria-hidden className="shrink-0 text-[var(--v2-muted)] opacity-0 transition-opacity group-hover/tile:opacity-100" />
          </button>
          <div className="flex min-h-0 flex-1 flex-col"><SeatPane project={project} seat={s} interactive={layout === "split"} /></div>
        </SeatTile>
      ))}
    </div>
  );
}

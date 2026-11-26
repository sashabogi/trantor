import type { ReactNode } from "react";
import { useActivePane } from "../../ui/useActivePane";
// Split and Grid: several seats' live terminals at once; click a tile's header to focus that seat (#13987).
import { Avatar } from "../../ui/Avatar";
import { PRESENCE_COLOR } from "../../ui/identity";
import { AgentDot } from "./AgentDot";
import { SeatPane } from "./WorkArea";
import { gridColumns, type Layout, type SeatView } from "./seatModel";

function SeatTile({ seat, selected, children }: { seat: SeatView; selected: boolean; children: ReactNode }) {
  const pane = useActivePane(seat.presence === "working");
  return <div {...pane} data-selected={selected || undefined}
    className="flex min-h-[240px] min-w-0 flex-col overflow-hidden rounded-xl bg-[var(--v2-chrome)] p-2">{children}</div>;
}

export function SeatGrid({ project, seats, layout, selectedKey, onFocus }: {
  project: string; seats: SeatView[]; layout: Layout; selectedKey: string | undefined; onFocus: (key: string) => void;
}) {
  const cols = layout === "split" ? Math.min(2, Math.max(1, seats.length)) : gridColumns(seats.length);
  if (!seats.length) {
    return <div className="m-5 rounded-xl border border-dashed border-[var(--v2-edge-2)] p-6 text-center text-v2-base text-[var(--v2-muted)]">No live seat to show. Add a seat above.</div>;
  }
  return (
    <div className="mx-5 mb-3.5 mt-3 grid min-h-0 flex-1 gap-2.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {seats.map(s => (
        <SeatTile key={s.key} seat={s} selected={s.key === selectedKey}>
          <button type="button" onClick={() => onFocus(s.key)} title={`Open ${s.label} full size`}
            className="mb-1.5 flex items-center gap-2 border-0 bg-transparent text-left text-v2-body text-[var(--v2-text)]">
            {s.agentInfo ? <AgentDot running={s.agentInfo.state === "running"} /> : <Avatar name={s.brand} size={20} presence={s.presence} surface="var(--v2-chrome)" />}
            <span className="font-medium">{s.label}</span>
            <span className="text-v2-small" style={{ color: PRESENCE_COLOR[s.presence] }}>{s.words}</span>
          </button>
          <div className="flex min-h-0 flex-1 flex-col"><SeatPane project={project} seat={s} interactive={layout === "split"} /></div>
        </SeatTile>
      ))}
    </div>
  );
}

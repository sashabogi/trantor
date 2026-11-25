// The seat strip: one chip per live seat, +N offline, add seat, the layout switch and Record (#13987).
import { Columns2, Grid2x2, Plus, Square } from "lucide-react";
import { Avatar } from "../../ui/Avatar";
import { PRESENCE_COLOR } from "../../ui/identity";
import { Seg, type SegOption } from "../../ui/Seg";
import { PopMenu } from "./PopMenu";
import { liveSeats, offlineNote, offlineSeats, type Layout, type SeatView } from "./seatModel";
import type { Crew } from "./useCrew";

const LAYOUTS: readonly SegOption<Layout>[] = [
  { value: "focus", label: "Focus", title: "Focus: one seat", icon: <Square size={12} aria-hidden /> },
  { value: "split", label: "Split", title: "Split: two seats side by side", icon: <Columns2 size={12} aria-hidden /> },
  { value: "grid", label: "Grid", title: "Grid: every seat", icon: <Grid2x2 size={12} aria-hidden /> },
];

function SeatChip({ seat, on, onSelect }: { seat: SeatView; on: boolean; onSelect: () => void }) {
  const sub = seat.isOrchestrator ? "you" : seat.words;
  return (
    <button type="button" aria-pressed={on} title={seat.session} onClick={onSelect}
      className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-[10px] border px-2.5 py-1.5 text-[12px] font-medium text-[var(--v2-text)]"
      style={{ background: on ? "var(--v2-info-soft)" : "var(--v2-panel-2)", borderColor: on ? "var(--v2-info-edge)" : "var(--v2-edge)" }}>
      <Avatar name={seat.brand} size={22} presence={seat.presence} surface={on ? "var(--v2-info-soft)" : "var(--v2-panel-2)"} />
      {seat.label}
      <span className="text-[10.5px]" style={{ color: seat.presence === "working" || seat.isOrchestrator ? "var(--v2-muted)" : PRESENCE_COLOR[seat.presence] }}>{sub}</span>
    </button>
  );
}

export function SeatStrip({ seats, selectedKey, onSelect, layout, onLayout, crew, recording, onRecord }: {
  seats: SeatView[]; selectedKey: string | undefined; onSelect: (key: string) => void;
  layout: Layout; onLayout: (l: Layout) => void; crew: Crew; recording: boolean; onRecord: () => void;
}) {
  const offline = offlineSeats(seats);
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto border-b border-[var(--v2-edge)] px-5 py-2.5">
      {liveSeats(seats).map(s => <SeatChip key={s.key} seat={s} on={s.key === selectedKey} onSelect={() => onSelect(s.key)} />)}
      {offline.length > 0 && (
        <PopMenu heading="Offline seats" empty="No offline seats"
          items={offline.map(s => ({ id: s.key, label: `Start ${s.label}`, sub: offlineNote(s), disabledReason: crew.busy ? "Another seat action is running" : null, onPick: () => void crew.start(s.agent) }))}
          trigger={(p, open) => (
            <button type="button" {...p} title={offline.map(s => `${s.label}, ${offlineNote(s)}`).join("\n")}
              className="shrink-0 whitespace-nowrap rounded-[10px] border border-dashed border-[var(--v2-edge-2)] bg-transparent px-2.5 py-1.5 text-[12px] font-medium text-[var(--v2-muted)] hover:text-[var(--v2-text)]"
              data-open={open || undefined}>+{offline.length} offline</button>
          )} />
      )}
      <PopMenu heading="Add a seat" empty="No agent is installed, enabled and within quota"
        items={crew.available.map(a => ({ id: a.id, label: a.label, sub: `starts ${a.launch}`, disabledReason: crew.busy ? "Another seat action is running" : null, onPick: () => void crew.start(a.id) }))}
        trigger={p => (
          <button type="button" {...p} aria-label="Add a seat" title="Add a seat"
            className="v2-hover inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] border border-dashed border-[var(--v2-edge-2)] bg-transparent text-[var(--v2-muted)]">
            <Plus size={13} strokeWidth={2.2} aria-hidden />
          </button>
        )} />
      <span className="flex-1" />
      <Seg label="Layout" options={LAYOUTS} value={layout} onChange={onLayout} />
      <button type="button" aria-pressed={recording} onClick={onRecord}
        title="Record a drill: opens Drill Mode, which stages a disposable project and captures the evidence"
        className="v2-hover inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--v2-edge-2)] bg-transparent px-[9px] py-[5px] text-[11.5px] font-medium text-[var(--v2-text-2)]">
        <span aria-hidden className="h-2 w-2 rounded-full bg-[var(--v2-bad)]" />Record
      </button>
    </div>
  );
}

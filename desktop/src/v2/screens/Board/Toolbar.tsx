// View switch, search, seat filters and quick chips above the lanes (#13989).
import { useState } from "react";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { Seg } from "../../ui/Seg";
import { SEAT_FILTER_MAX, type Filters, type SeatGroup } from "./model";

export type View = "lanes" | "list" | "dependencies" | "seat";
const VIEWS = [
  { value: "lanes", label: "Lanes" },
  { value: "list", label: "List" },
  { value: "dependencies", label: "Dependencies", title: "Cards joined by what they depend on, in the order they can merge" },
  { value: "seat", label: "By seat", title: "One row per seat" },
] as const satisfies readonly { value: View; label: string; title?: string }[];

export type ToolbarProps = {
  view: View;
  onView: (v: View) => void;
  filters: Filters;
  onFilters: (f: Filters) => void;
  seats: SeatGroup[];
  counts: { needsYou: number; drillOwed: number };
  onNewCard: () => void;
};

function QuickChip({ label, count, on, onClick, title, disabledReason }: {
  label: string; count?: number; on: boolean; onClick?: () => void; title?: string; disabledReason?: string;
}) {
  const off = !!disabledReason;
  return (
    <button type="button" aria-pressed={on} disabled={off} onClick={onClick} title={disabledReason ?? title}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-[10px] py-[3px] text-v2-body font-medium disabled:opacity-45 ${
        on ? "border-[var(--v2-info-edge)] bg-[var(--v2-accent-soft)] text-[var(--v2-accent-hi)]" : "border-[var(--v2-edge)] bg-transparent text-[var(--v2-text-2)] hover:bg-[var(--v2-raised)]"}`}>
      {label}{count !== undefined && <span className="text-v2-small text-[var(--v2-muted)]">{count}</span>}
    </button>
  );
}

export function Toolbar({ view, onView, filters, onFilters, seats, counts, onNewCard }: ToolbarProps) {
  const set = (patch: Partial<Filters>) => onFilters({ ...filters, ...patch });
  const [more, setMore] = useState(false);
  const isOn = (g: SeatGroup) => g.ids.some(id => filters.seats.includes(id));
  const toggleSeat = (g: SeatGroup) => set({ seats: isOn(g) ? filters.seats.filter(x => !g.ids.includes(x)) : [...filters.seats, ...g.ids] });
  const shownSeats = more ? seats : seats.slice(0, SEAT_FILTER_MAX);
  return (
    <div className="flex flex-wrap items-center gap-2.5 px-5 py-3">
      <Seg label="View" options={VIEWS} value={view} onChange={onView} />
      <label htmlFor="v2-board-search" className="sr-only">Search cards</label>
      <input id="v2-board-search" type="text" value={filters.query} onChange={e => set({ query: e.target.value })}
        placeholder="Search: text, #id, @seat"
        className="w-[230px] rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel-2)] px-2.5 py-[5px] text-v2-body text-[var(--v2-text)] placeholder:text-[var(--v2-muted)]" />
      {seats.length > 0 && (
        <div role="group" aria-label="Filter by seat" className="flex items-center gap-1">
          <span className="mr-0.5 text-v2-small text-[var(--v2-muted)]">Seat</span>
          {shownSeats.map(g => {
            const on = isOn(g);
            return (
              <button key={g.label} type="button" aria-pressed={on} title={`${g.label}, ${g.open} open ${g.open === 1 ? "card" : "cards"}`} aria-label={`Filter by ${g.label}`} onClick={() => toggleSeat(g)}
                className={`rounded-full border-2 bg-transparent p-0 ${on ? "border-[var(--v2-accent)]" : "border-transparent opacity-80 hover:opacity-100"}`}>
                <Avatar name={g.ids[0]} size={22} />
              </button>
            );
          })}
          {!more && seats.length > SEAT_FILTER_MAX && (
            <button type="button" onClick={() => setMore(true)} title="Show the other seats with open cards"
              className="rounded-full border border-[var(--v2-edge)] px-2 py-0.5 text-v2-small text-[var(--v2-muted)] hover:bg-[var(--v2-raised)]">+{seats.length - SEAT_FILTER_MAX}</button>
          )}
        </div>
      )}
      <QuickChip label="Needs you" count={counts.needsYou} on={filters.needsYou} onClick={() => set({ needsYou: !filters.needsYou })}
        title="Testing cards nobody is driving, and anything failed or blocked" />
      <QuickChip label="Drill owed" count={counts.drillOwed} on={filters.drillOwed} onClick={() => set({ drillOwed: !filters.drillOwed })}
        title="Every card in testing: done is refused until its drill has run" />
      <QuickChip label="Sub-agents nested" on={filters.nested} onClick={() => set({ nested: !filters.nested })}
        title="Sub-agent cards roll up under the card that spawned them" />
      <span className="flex-1" />
      <Button variant="primary" onClick={onNewCard}>New card</Button>
    </div>
  );
}

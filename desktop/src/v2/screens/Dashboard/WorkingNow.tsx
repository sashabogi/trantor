// "Working now": per-project tabs, the one-line list, and the grid toggle (#13986).
import { useState } from "react";
import { LayoutGrid, List, Users } from "lucide-react";
import type { Navigate } from "../../routes";
import { Avatar } from "../../ui/Avatar";
import { seatLabel } from "../../ui/identity";
import { ProjectTile } from "../../ui/ProjectTile";
import { Section } from "../../ui/Section";
import { Seg } from "../../ui/Seg";
import { seatsFor, seatTabs, seatTime, type QueueItem, type Seat } from "./model";
import { CardChip, MayDo, SeatActions } from "./SeatParts";
import { WorkingGrid } from "./WorkingGrid";
import type { Decisions } from "./useDecisions";

type View = "list" | "grid";
type Props = {
  seats: Seat[]; queue: QueueItem[]; autonomy: ReadonlyMap<string, number>; d: Decisions; onNavigate: Navigate;
};

function Tabs({ seats, tab, setTab }: { seats: Seat[]; tab: string; setTab: (t: string) => void }) {
  const cls = (on: boolean) => `inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] ${on ? "bg-[var(--v2-hover)] text-[var(--v2-text)]" : "text-[var(--v2-muted)] hover:text-[var(--v2-text)]"}`;
  return (
    <div role="tablist" aria-label="Projects with seats" className="flex flex-wrap gap-1 border-b border-[var(--v2-edge)] px-3 py-2">
      <button type="button" role="tab" aria-selected={tab === ""} onClick={() => setTab("")} className={cls(tab === "")}>
        All <span className="v2-mono">{seats.length}</span>
      </button>
      {seatTabs(seats).map(t => (
        <button key={t.project} type="button" role="tab" aria-selected={tab === t.project} onClick={() => setTab(t.project)} className={cls(tab === t.project)}>
          <ProjectTile name={t.project} size={14} />{t.project} <span className="v2-mono">{t.count}</span>
        </button>
      ))}
    </div>
  );
}

function SeatRow({ seat, autonomy, onNavigate }: { seat: Seat; autonomy: ReadonlyMap<string, number>; onNavigate: Navigate }) {
  return (
    <div data-seat={seatLabel(seat.session)} className="flex items-center gap-3 border-b border-[var(--v2-edge)] px-3.5 py-2 last:border-b-0">
      <Avatar name={seat.session} size={28} presence={seat.presence} surface="var(--v2-panel)" />
      <span className="w-[150px] shrink-0">
        <span className="block truncate text-[13px] font-medium text-[var(--v2-text)]">{seatLabel(seat.session)}</span>
        <span className="block truncate text-[11px] text-[var(--v2-muted)]">{[seat.project, seat.model, seat.machine].filter(Boolean).join(" · ")}</span>
      </span>
      <span className="min-w-0 flex-1"><CardChip seat={seat} /></span>
      <MayDo level={autonomy.get(seat.project)} />
      <span className="v2-mono w-[72px] shrink-0 text-right text-[11.5px] text-[var(--v2-muted)]">{seatTime(seat)}</span>
      <SeatActions seat={seat} onNavigate={onNavigate} />
    </div>
  );
}

export function WorkingNow({ seats, queue, autonomy, d, onNavigate }: Props) {
  const [tab, setTab] = useState("");
  const [view, setView] = useState<View>("list");
  const [per, setPer] = useState<"2" | "3" | "4">("3");
  const shown = seatsFor(seats, tab);
  const toggle = (
    <>
      {view === "grid" && (
        <Seg label="Tiles per row" value={per} onChange={setPer} options={[{ value: "2", label: "2" }, { value: "3", label: "3" }, { value: "4", label: "4" }]} />
      )}
      <Seg label="Seat view" value={view} onChange={setView} options={[
        { value: "list", label: "List", icon: <List size={13} aria-hidden />, title: "List view" },
        { value: "grid", label: "Grid", icon: <LayoutGrid size={13} aria-hidden />, title: "Grid view: one tile per seat" },
      ]} />
    </>
  );
  return (
    <Section title={`Working now`} sub={`${seats.length} seat${seats.length === 1 ? "" : "s"} live`} actions={toggle} flush>
      <Tabs seats={seats} tab={tab} setTab={setTab} />
      {shown.length === 0 && (
        <p className="m-0 flex items-center gap-2 px-3.5 py-4 text-[12.5px] text-[var(--v2-muted)]"><Users size={14} aria-hidden />No seat is live{tab ? ` on ${tab}` : ""}.</p>
      )}
      {view === "list" ? shown.map(s => <SeatRow key={`${s.project}:${s.session}`} seat={s} autonomy={autonomy} onNavigate={onNavigate} />)
        : <WorkingGrid seats={shown} queue={queue} autonomy={autonomy} perRow={Number(per)} d={d} onNavigate={onNavigate} />}
    </Section>
  );
}

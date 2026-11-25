// The Working grid: one tile per seat, with the seat's own pending ask on it (#13986).
import { Maximize2, TerminalSquare } from "lucide-react";
import type { Navigate } from "../../routes";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { seatLabel } from "../../ui/identity";
import { seatTime, type QueueItem, type Seat } from "./model";
import { CardChip, MayDo, SeatActions } from "./SeatParts";
import type { Decisions } from "./useDecisions";

type Props = {
  seats: Seat[]; queue: QueueItem[]; autonomy: ReadonlyMap<string, number>;
  perRow: number; d: Decisions; onNavigate: Navigate;
};

/** The seat's own waiting proposal or hold, so the tile can carry the same buttons as the queue. */
function PendingStrip({ item, d }: { item: QueueItem; d: Decisions }) {
  const off = d.busy ? "Saving a decision" : null;
  const { proposal, hold } = item;
  return (
    <div className="flex items-center gap-2 border-t border-[var(--v2-warn-edge)] bg-[var(--v2-warn-soft)] px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-v2-body text-[var(--v2-warn)]">{item.title}</span>
      {proposal && (
        <>
          <Button variant="primary" disabledReason={off} onClick={() => void d.decideProposal(proposal, "approved")}>Approve</Button>
          <Button variant="danger" disabledReason={off} onClick={() => void d.decideProposal(proposal, "denied")}>Deny</Button>
        </>
      )}
      {hold && (
        <>
          <Button variant="primary" disabledReason={off} onClick={() => void d.decideHold(hold, "go")}>{seatLabel(hold.session)} first</Button>
          <Button disabledReason={off} onClick={() => void d.decideHold(hold, "nogo")}>{seatLabel(hold.other)} first</Button>
        </>
      )}
    </div>
  );
}

function Tile({ seat, pending, autonomy, d, onNavigate }: { seat: Seat; pending?: QueueItem; autonomy: ReadonlyMap<string, number>; d: Decisions; onNavigate: Navigate }) {
  return (
    <article aria-label={seatLabel(seat.session)} className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--v2-edge)] bg-[var(--v2-panel-2)]">
      <header className="flex items-center gap-2.5 px-3 py-2.5">
        <Avatar name={seat.session} size={26} presence={seat.presence} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-v2-base font-medium text-[var(--v2-text)]">{seatLabel(seat.session)}</span>
          <span className="block truncate text-v2-small text-[var(--v2-muted)]">{[seat.project, seat.model, seat.machine].filter(Boolean).join(" · ")}</span>
          <CardChip seat={seat} />
        </span>
        <IconButton label={`Focus ${seatLabel(seat.session)} full window`} title="Focus: open full window" onClick={() => onNavigate("workspace", seat.project)}>
          <Maximize2 size={14} aria-hidden />
        </IconButton>
      </header>
      <div className="v2-mono flex min-h-[96px] items-center justify-center gap-2 border-y border-[var(--v2-edge)] bg-[var(--v2-bg)] px-3 text-v2-body text-[var(--v2-muted)]">
        <TerminalSquare size={14} aria-hidden />Its terminal opens in the Workspace: use Watch live.
      </div>
      {pending && <PendingStrip item={pending} d={d} />}
      <footer className="flex items-center gap-2 px-3 py-2">
        <MayDo level={autonomy.get(seat.project)} />
        <span className="v2-mono flex-1 text-v2-body text-[var(--v2-muted)]">{seatTime(seat)}</span>
        <SeatActions seat={seat} onNavigate={onNavigate} />
      </footer>
    </article>
  );
}

export function WorkingGrid({ seats, queue, autonomy, perRow, d, onNavigate }: Props) {
  return (
    <div className="grid gap-3 p-3" style={{ gridTemplateColumns: `repeat(${perRow}, minmax(0, 1fr))` }}>
      {seats.map(s => (
        <Tile key={`${s.project}:${s.session}`} seat={s} autonomy={autonomy} d={d} onNavigate={onNavigate}
          pending={queue.find(q => q.project === s.project && q.seat === s.session && (q.proposal || q.hold))} />
      ))}
    </div>
  );
}

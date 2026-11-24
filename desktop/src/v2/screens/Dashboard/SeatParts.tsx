// Pieces both Working views share: the card chip, the may-do chip, and the seat's icon actions (#13986).
import { Eye, MessageSquare, Repeat, Square } from "lucide-react";
import type { Navigate } from "../../routes";
import { Chip } from "../../ui/Chip";
import { IconButton } from "../../ui/IconButton";
import type { Seat } from "./model";

export const NO_STOP = "Stopping a seat from the app needs a hub stop endpoint that does not exist yet";
export const NO_SWAP = "Swapping a seat's model needs a hub swap endpoint that does not exist yet";

export function CardChip({ seat }: { seat: Seat }) {
  if (!seat.card) return <span className="text-[12px] text-[var(--v2-muted)]">{seat.status || "no card"}</span>;
  return (
    <span className="min-w-0 truncate text-[12.5px] text-[var(--v2-text)]">
      <span className="v2-mono text-[var(--v2-accent)]">#{seat.card.id}</span> {seat.card.title}
    </span>
  );
}

/** The autonomy level the overseer holds for the seat's project; absent means the hub reports none. */
export function MayDo({ level }: { level: number | undefined }) {
  if (level === undefined) return null;
  return <Chip title={`Autonomy level ${level} for this project, set by the overseer policy`}>Autonomy {level}</Chip>;
}

export function SeatActions({ seat, onNavigate }: { seat: Seat; onNavigate: Navigate }) {
  const name = seat.session;
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <IconButton label={`Watch ${name} live`} title="Watch live: open its terminal and changes" onClick={() => onNavigate("workspace", seat.project)}>
        <Eye size={14} aria-hidden />
      </IconButton>
      <IconButton label={`Message ${name}`} title="Send it a message" onClick={() => onNavigate("bus", seat.project)}>
        <MessageSquare size={14} aria-hidden />
      </IconButton>
      <IconButton label={`Swap ${name} for another model`} title={NO_SWAP} disabled><Repeat size={14} aria-hidden /></IconButton>
      <IconButton label={`Stop ${name}`} title={NO_STOP} disabled><Square size={14} aria-hidden /></IconButton>
    </span>
  );
}

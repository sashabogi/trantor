// The card after a short rest on a seat tab: the full astronaut with name and state, and one row per fact the seat really has (#14351).
// Pointer-transparent by the spec, so the card row is styled like a link but the click is the seat bar's.
import type { ReactNode } from "react";
import type { Card } from "../../../shared/api/client";
import { seatState, STATE_WORD } from "../../ui/identity";
import { SeatAstronaut } from "../../ui/SeatAstronaut";
import { useBranch, useChangeCount, type Branch, type ChangeCount } from "./seatFacts";
import type { SeatView } from "./seatModel";
import type { MayDo } from "./useWorkspaceData";

export type HoverRow = { key: string; value: ReactNode; mono?: boolean };

/** The rows a seat has something to say for, in order; a row with nothing to say is left out. */
export function hoverRows(seat: SeatView, card: Card | undefined, branch: Branch, changes: ChangeCount, mayDo: MayDo): HoverRow[] {
  const rows: (HoverRow | null)[] = [
    card ? { key: "Doing", value: <span className="text-[var(--v2-accent)]">#{card.id} {card.title}</span> } : null,
    branch ? { key: "Branch", mono: true, value: `${branch.name}${branch.ahead ? ` ↑${branch.ahead}` : ""}` } : null,
    changes && changes.files > 0 ? { key: "Changes", value: <><span className="text-[var(--v2-ok)]">+{changes.plus}</span> <span className="text-[var(--v2-bad)]">-{changes.minus}</span> · {changes.files} {changes.files === 1 ? "file" : "files"}</> } : null,
    seat.machine ? { key: "Machine", value: seat.machine } : null,
    mayDo ? { key: "May do", value: mayDo.label.replace(/^New sessions: /, "") } : null,
  ];
  return rows.filter((r): r is HoverRow => r !== null);
}

export function SeatHoverCard({ project, seat, card, mayDo }: { project: string; seat: SeatView; card: Card | undefined; mayDo: MayDo }) {
  const branch = useBranch(project, seat);
  const changes = useChangeCount(project, seat);
  const rows = hoverRows(seat, card, branch, changes, mayDo);
  return (
    <div className="w-[300px] max-w-[300px] rounded-lg border border-[var(--v2-edge-2)] bg-[var(--v2-raised)] p-3 text-v2-small shadow-[var(--v2-shadow-menu)]">
      <div className="flex items-center gap-3">
        <SeatAstronaut vendor={seat.brand} name={seat.label} state={seatState(seat)} size={48} variant="full" surface="var(--v2-raised)" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-v2-base font-semibold text-[var(--v2-text)]">{seat.label}</span>
          <span className="text-v2-small text-[var(--v2-muted)]">{STATE_WORD[seatState(seat)]}</span>
        </div>
      </div>
      {rows.length > 0 && (
        <dl className="mt-3 grid grid-cols-[72px_1fr] gap-x-2 gap-y-1.5">
          {rows.map(r => (
            <div key={r.key} className="contents" data-row={r.key}>
              <dt className="text-[var(--v2-muted)]">{r.key}</dt>
              <dd className={`m-0 min-w-0 truncate text-[var(--v2-text)] ${r.mono ? "v2-mono" : ""}`}>{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

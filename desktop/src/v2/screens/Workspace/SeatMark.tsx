// The vendor mark with the 8px state dot on its corner, the one place a seat's state is drawn (#14351).
import type { CSSProperties } from "react";
import { Avatar } from "../../ui/Avatar";
import { seatState, STATE_WORD, stateDot } from "../../ui/identity";
import type { SeatView } from "./seatModel";

export function StateDot({ seat, ring }: { seat: Pick<SeatView, "presence" | "words">; ring?: string }) {
  const state = seatState(seat);
  const dot = stateDot(state);
  const style: CSSProperties = { ...dot.style };
  if (ring) style.outline = `2px solid ${ring}`;
  return (
    <span role="img" aria-label={STATE_WORD[state]} data-state={state} className={`block size-2 shrink-0 rounded-full ${dot.className}`} style={style} />
  );
}

export function SeatMark({ seat, ring, size = 20 }: { seat: Pick<SeatView, "brand" | "presence" | "words">; ring: string; size?: number }) {
  return (
    <span className="relative inline-flex shrink-0">
      <Avatar name={seat.brand} size={size} surface={ring} />
      <span className="absolute -bottom-px -right-px"><StateDot seat={seat} ring={ring} /></span>
    </span>
  );
}

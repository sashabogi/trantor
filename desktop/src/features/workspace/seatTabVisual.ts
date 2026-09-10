// The seat tab's state-to-visual mapping (#5890): a blue dot does not say "working", motion does.
// A turn in progress pulses the mark; blocked is amber and STILL; idle is still; down/errored is
// still in the failure colour. The state comes from herdr's own words or the hub status the runner
// writes (#5965); this maps either vocabulary to the same contract. Pure.
import { hubActivity, type SeatActivity } from "./seatActivity";

export type SeatTabState = SeatActivity;

export type SeatTabVisual = {
  state: SeatTabState;
  /** The tab's title attribute — the state, said in words. */
  title: string;
  /** Quiet pulse on the brand mark: ONLY while a turn is running. */
  pulse: boolean;
  /** Amber treatment (mark ring + name): only when the seat needs the operator. */
  amber: boolean;
  /** Failure treatment (mark ring + name): only when the seat is down/errored. */
  down: boolean;
};

const ofState = (state: SeatTabState, name: string): SeatTabVisual => {
  switch (state) {
    case "working":
      return { state, title: `${name} — working`, pulse: true, amber: false, down: false };
    case "blocked":
      return { state, title: `${name} — blocked, waiting on you`, pulse: false, amber: true, down: false };
    case "down":
      return { state, title: `${name} — down`, pulse: false, amber: false, down: true };
    default:
      return { state: "idle", title: `${name} — idle`, pulse: false, amber: false, down: false };
  }
};

/** The visual for a raw status string. herdr's own words map straight across; anything else is
 *  resolved as a hub/runner status (`working · kickoff`, `down: auth`, …). Case/whitespace-tolerant,
 *  so the same tab logic serves the live string and whatever the caller stored. */
export function seatTabVisual(status: string | undefined, name: string): SeatTabVisual {
  const s = (status ?? "").trim().toLowerCase();
  // herdr's per-pane vocabulary, kept for panes herdr does see (seat_state, pane status streams).
  if (s === "working" || s === "busy") return ofState("working", name);
  if (s === "blocked") return ofState("blocked", name);
  return ofState(hubActivity(status), name);
}

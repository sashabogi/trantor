// The seat tab's state-to-visual mapping (#5890). The operator's ruling: a blue dot does not say
// "working" — motion does. So: a turn in progress pulses the mark; blocked is amber and STILL
// (attention without noise); idle is still and quiet. The state comes from the herdr per-pane
// agent status the Workspace already subscribes to — this file only decides what it looks like.
// Pure, so the whole visual contract is unit-tested.
export type SeatTabState = "working" | "blocked" | "idle";

export type SeatTabVisual = {
  state: SeatTabState;
  /** The tab's title attribute — the state, said in words. */
  title: string;
  /** Quiet pulse on the brand mark: ONLY while a turn is running. */
  pulse: boolean;
  /** Amber treatment (mark ring + name): only when the seat needs the operator. */
  amber: boolean;
};

/** herdr's per-pane statuses, mapped. "busy" is herdr's own word for a running turn
 *  (agents.tsx already translated it); "blocked" means an approval is owed; everything else —
 *  idle, unknown, absent — is still. */
export function seatTabVisual(status: string | undefined, name: string): SeatTabVisual {
  const s = (status ?? "").trim().toLowerCase();
  if (s === "working" || s === "busy") {
    return { state: "working", title: `${name} — working`, pulse: true, amber: false };
  }
  if (s === "blocked") {
    return { state: "blocked", title: `${name} — blocked, waiting on you`, pulse: false, amber: true };
  }
  return { state: "idle", title: `${name} — idle`, pulse: false, amber: false };
}

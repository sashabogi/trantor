// STATUS ARBITER, pure on purpose (#6146). `status` is fed by two async, racing sources: a
// one-shot `orchestrator_status` seed at mount, and a stream of "orch-status" pushes from the
// Rust watcher. Ordering is by `seq`, assigned at DISPATCH or RECEIPT, never at promise-settle
// time; `apply` keeps the highest seq seen, so a late-resolving seed can never undo a newer push.
export type StatusSource = "seed" | "push";
export type StatusEvent = { source: StatusSource; seq: number; value: string };
export type ArbiterState = { value: string; seq: number };

/** Before anything has been dispatched or received. `seq: -1` so the very first event (seq 0,
 *  minted by the caller's counter) always wins — the counter never has to special-case seq 0. */
export const initialArbiterState: ArbiterState = { value: "unknown", seq: -1 };

/** Fold one event into the arbiter. A strictly newer seq replaces the state; a seq at or below
 *  the one already applied is a late/duplicate arrival and is dropped — same object back, so
 *  callers can tell "applied" from "dropped" with a reference check. */
export function apply(current: ArbiterState, ev: StatusEvent): ArbiterState {
  if (ev.seq <= current.seq) return current;
  return { value: ev.value, seq: ev.seq };
}

/** The bounded re-seed schedule (mechanism #3 of #6146): offsets from mount, in milliseconds, at
 *  which the seed is worth re-dispatching if the effective status is still closed. Finite and
 *  short — never an unbounded poll; the monitoring doctrine forbids that, and pushes carry the
 *  steady state once the first one lands. */
export const RESEED_DELAYS_MS = [2_000, 5_000, 15_000, 30_000] as const;

/** Whether the effective status is worth another seed attempt. "none" and "unknown" are the
 *  closed not-live set streaming.ts's `sessionLiveness` also treats as dead — anything else means
 *  a push has already delivered real information and the schedule has nothing left to fix. */
export function needsReseed(status: string): boolean {
  return status === "none" || status === "unknown";
}

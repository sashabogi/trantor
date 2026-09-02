// STATUS ARBITER — pure on purpose (#6146). The composer's liveness (streaming.ts's
// sessionLiveness) is decided by one string, `status`, fed by two sources that race: a one-shot
// `orchestrator_status` seed dispatched at mount (and re-dispatched a few times on recovery), and
// a stream of "orch-status" pushes from the Rust watcher `chat_watch` spawns. Both are async and
// nothing here assumes which one resolves first.
//
// The real-path failure (2026-09-02, card #6146): the operator created project pr-os from the
// genesis sheet. The Rust watcher found the orchestrator pane and pushed "blocked" then "working"
// within four seconds — but the composer stayed disabled with "no orchestrator session is behind
// this pane". Chat.tsx seeded `status` with `orchestrator_status` at mount AND independently set it
// from every "orch-status" push, so whichever resolved LAST won — and the seed, fired before the
// wake had written the crew-windows row, resolved to "none" AFTER a push had already delivered
// "working". A later arrival stomped an earlier, more current truth.
//
// The fix is ordering, not timing: every candidate update carries a `seq` assigned when it was
// DISPATCHED (a seed) or RECEIVED (a push) — never when its promise happens to settle — and
// `apply` keeps whichever update owns the highest seq it has ever seen. A seed born before a push
// arrived can resolve arbitrarily late; its seq still loses to the push's, so it can never undo it.
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

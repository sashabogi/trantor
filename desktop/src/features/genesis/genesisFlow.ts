// genesisFlow.ts: the pure state machine behind the "Start a project" sheet (#6161).
// The sheet used to await BOTH `trantor new` AND the orchestrator wake before closing, so a slow
// wake left it open with a disabled Cancel and no progress. Now it closes the moment `trantor new`
// succeeds; the wake becomes a detached step surfaced only as a toast. No React, no side effects.

export type GenesisState =
  | { status: "idle" }
  | { status: "creating" }
  | { status: "waking"; project: string }
  | { status: "done"; project: string }
  | { status: "exists"; parent: string; name: string; message: string }
  | { status: "error"; message: string };

export type GenesisEvent =
  | { type: "submit" }
  | { type: "createOk"; project: string }
  | { type: "createExists"; parent: string; name: string; message: string }
  | { type: "createError"; message: string }
  | { type: "wakeOk" }
  | { type: "wakeError"; message: string }
  | { type: "reset" };

export const GENESIS_IDLE: GenesisState = { status: "idle" };

/** #6120 Blank path kickoff. The contract: it says the project is empty and asks what to build.
 *  Never recap wording (that is the wake's job, PLAIN_WAKE_KICKOFF) and never review wording
 *  (#6112, genesis.ts's genesisKickoff) — those belong to the other two entries into a project. */
export const BLANK_KICKOFF =
  "This project is empty, nothing is built yet. Ask the operator what to build first.";

/** idle → creating → waking → done | exists | error (exists/error can also loop back to
 *  creating on retry via a fresh "submit"). Transitions from the wrong state are dropped rather
 *  than thrown — a stale async result racing a user reset must never corrupt the sheet's state. */
export function genesisReducer(state: GenesisState, event: GenesisEvent): GenesisState {
  switch (event.type) {
    case "submit":
      return { status: "creating" };
    case "createOk":
      return state.status === "creating" ? { status: "waking", project: event.project } : state;
    case "createExists":
      return state.status === "creating"
        ? { status: "exists", parent: event.parent, name: event.name, message: event.message }
        : state;
    case "createError":
      return state.status === "creating" ? { status: "error", message: event.message } : state;
    case "wakeOk":
      return state.status === "waking" ? { status: "done", project: state.project } : state;
    case "wakeError":
      return state.status === "waking" ? { status: "error", message: event.message } : state;
    case "reset":
      return GENESIS_IDLE;
  }
}

/** Matches the CLI's plain-text conflict error. `bin/new.mjs`'s `die()` never emits a JSON error
 *  code — this substring IS the contract, so keep it in sync with that message. */
export function isExistsNotEmptyError(message: string): boolean {
  return /already exists and is not empty/i.test(message);
}

/** The one calm, one-line toast the flow ever shows: "<name> created · orchestrator waking" the
 *  instant the sheet closes, and a wake failure afterward — since by then there is no dialog left
 *  to surface it in. Returns null for every transition that already has visible UI of its own
 *  (validation errors, the exists/adopt offer). */
export function toastForTransition(prev: GenesisState, next: GenesisState): { title: string; body: string } | null {
  if (prev.status === next.status) return null;
  if (next.status === "waking") {
    return { title: `${next.project} created`, body: "orchestrator waking" };
  }
  if (next.status === "error" && prev.status === "waking") {
    return { title: "Orchestrator wake failed", body: next.message };
  }
  return null;
}

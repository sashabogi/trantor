// wakeProgress.ts — the frontend's read on a running wake chain (#6201), the mirror of
// workspace/handoffProgress.ts for handoff chains (#6081). The wake used to go quiet for the
// whole idle gate (88s on tiny-timer) while the session's own startup made the chat header read
// "working", so the operator read a woken session as idle with nothing to do. Rust now marks the
// chain (wake_in_progress, the mount-time truth) and emits wake-progress at every step; the
// sidebar row and the chat header follow it. One invoke + one event name, both owned by
// genesis.rs project_wake.
import { invoke } from "@tauri-apps/api/core";
import { WAKE_PENDING_LINE, WAKE_SENT_LINE, type WakeRowState } from "./wakeRow";

export const WAKE_PROGRESS_EVENT = "wake-progress";

/** The phases the event carries, verbatim from Rust: lib.rs's KickoffPhase ladder phases
 *  (waiting_idle → kickoff_sent → kickoff_landed) plus genesis.rs's two ends — opened (the pane
 *  is known and live) and ended (the chain is done or was refused before it ran). The names are
 *  asserted in genesis::tests::kickoff_phase_names_are_the_frontend_contract. */
export type WakePhase = "opened" | "waiting_idle" | "kickoff_sent" | "kickoff_landed" | "ended";

export type WakeProgress = { project: string; phase: WakePhase; detail: string | null };

/** The projects with a wake chain in flight right now. Queried on mount — an event alone would
 *  race a window opened mid-wake, so the mount-time truth comes from Rust state, and the event
 *  keeps it current afterwards. */
export async function wakeInProgress(): Promise<string[]> {
  return invoke<string[]>("wake_in_progress");
}

/** What the chat header says about the chain (#6201): the pending line during the gate and the
 *  send, then the outcome — the landed detail is the same operator-worded label the wake command
 *  returns. Null on ended: the note's absence IS the quiet state, never dead chrome. */
export function wakeProgressText(phase: WakePhase, detail: string | null): { kind: "pending" | "outcome"; text: string } | null {
  switch (phase) {
    case "opened":
    case "waiting_idle":
      return { kind: "pending", text: WAKE_PENDING_LINE };
    case "kickoff_sent":
      return { kind: "pending", text: WAKE_SENT_LINE };
    case "kickoff_landed":
      return { kind: "outcome", text: detail ?? "kickoff ended" };
    case "ended":
      return null;
  }
}

/** Map one event onto the sidebar row's state vocabulary. Landed reads delivered as the good
 *  "sent" outcome; any other ending stays on the row to be read at leisure (kind "error" holds
 *  the row until the next click, and the full detail rides in the tooltip). Null means clear. */
export function wakeProgressRowState(phase: WakePhase, detail: string | null): WakeRowState | null {
  switch (phase) {
    case "opened":
    case "waiting_idle":
      return { phase: "kickoff", step: "pending" };
    case "kickoff_sent":
      return { phase: "kickoff", step: "sent" };
    case "kickoff_landed": {
      const delivered = detail !== null && /prompt delivered/.test(detail);
      return { phase: "outcome", kind: delivered ? "sent" : "error", text: detail ?? "kickoff ended" };
    }
    case "ended":
      return null;
  }
}

/** Fold one wake-progress event into the shell's wake-state map — the event guard (#6201). A
 *  phase still in flight sets its row; ended clears the row ONLY while it still shows an
 *  in-flight state: the chain lands (kickoff_landed) moments before the command's own answer
 *  arrives and re-sets the outcome with its fade timer, so an ended that overtakes a showing
 *  outcome must not cut the "few seconds" short. */
export function applyWakeProgress(prev: Map<string, WakeRowState>, p: WakeProgress): Map<string, WakeRowState> {
  const next = wakeProgressRowState(p.phase, p.detail);
  const cur = prev.get(p.project);
  if (next === null) {
    if (!cur || cur.phase === "outcome") return prev; // keep the outcome's timer; nothing to clear
    const m = new Map(prev);
    m.delete(p.project);
    return m;
  }
  if (cur?.phase === "kickoff" && next.phase === "kickoff" && cur.step === next.step) return prev; // same step again: no change
  const m = new Map(prev);
  m.set(p.project, next);
  return m;
}

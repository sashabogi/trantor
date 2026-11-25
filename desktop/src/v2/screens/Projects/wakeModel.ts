// What the 2.0 shell says about a new project's orchestrator wake (#13984). Pure: the classic
// wake vocabulary (features/genesis/wakeRow.ts) mapped to Workspace-sized sentences.
import type { WakeRowState } from "../../../features/genesis/wakeRow";

/** A wake with no word back after this long reads as stalled, never as an endless spinner. */
export const WAKE_DEADLINE_MS = 150_000;
export const STALLED_TEXT = "No answer from the orchestrator after 2 minutes";

/** Said once after create: wake cannot set a mode before its first prompt lands (#13984). */
export const PLAN_HINT = "Opened in Agent mode. Switch to Plan from the composer's first chip.";

export type WakeLine = { text: string; title?: string; tone: "muted" | "ok" | "danger"; retry: boolean };

export function wakeInFlight(state: WakeRowState | undefined): boolean {
  return state?.phase === "running" || state?.phase === "kickoff";
}

export function wakeStatusLine(state: WakeRowState | undefined): WakeLine | null {
  if (!state) return null;
  if (state.phase === "running") return { text: "Opening the orchestrator…", tone: "muted", retry: false };
  if (state.phase === "kickoff") {
    return state.step === "pending"
      ? { text: "Orchestrator is open. Waiting for it to take its first prompt…", tone: "muted", retry: false }
      : { text: "First prompt sent. Waiting on the session…", tone: "muted", retry: false };
  }
  switch (state.kind) {
    case "sent": return { text: "First prompt delivered to the orchestrator.", tone: "ok", title: state.text, retry: false };
    case "woken": return { text: "Orchestrator opened.", tone: "ok", title: state.text, retry: false };
    case "busy": return { text: "The orchestrator is mid-turn, so the first prompt was held.", tone: "muted", title: state.text, retry: true };
    case "unseatable": return { text: state.text, tone: "danger", title: state.text, retry: false };
    case "error": return { text: `Could not open the orchestrator: ${state.text}`, tone: "danger", title: state.text, retry: true };
  }
}

/** The shell notice: the same status without the failure detail the Workspace line carries. */
export function wakeToastText(state: WakeRowState | undefined): string | null {
  const line = wakeStatusLine(state);
  if (!line) return null;
  return state?.phase === "outcome" && state.kind === "error" ? "Could not open the orchestrator" : line.text;
}

// What the 2.0 shell says about a new project's orchestrator wake (#13984). Pure: the classic
// wake vocabulary (features/genesis/wakeRow.ts) mapped to Workspace-sized sentences.
import type { WakeRowState } from "../../../features/genesis/wakeRow";

/** The detached ladder has a 90s idle gate and a 90s prompt ladder; allow time for both. */
export const WAKE_DEADLINE_MS = 200_000;
export const STALLED_TEXT = "No answer from the orchestrator after 3 minutes 20 seconds";

/** Said once after create: the composer reads the session's mode instead of assuming one. */
export const PLAN_HINT = "Read or switch the session mode from the composer's first chip.";

export type WakeLine = { text: string; title?: string; tone: "muted" | "ok" | "danger"; retry: boolean };

export function wakeInFlight(state: WakeRowState | undefined): boolean {
  return state?.phase === "running" || state?.phase === "kickoff";
}

export function wakeStatusLine(state: WakeRowState | undefined, elapsedSeconds?: number): WakeLine | null {
  if (!state) return null;
  const elapsed = elapsedSeconds === undefined ? "" : ` · ${elapsedSeconds}s`;
  if (state.phase === "running") return { text: `Opening the orchestrator…${elapsed}`, tone: "muted", retry: false };
  if (state.phase === "kickoff") {
    return state.step === "pending"
      ? { text: `Orchestrator is open. Waiting for it to take its first prompt…${elapsed}`, tone: "muted", retry: false }
      : { text: `First prompt sent. Waiting on the session…${elapsed}`, tone: "muted", retry: false };
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
export function wakeNoticeText(state: WakeRowState | undefined): string | null {
  const line = wakeStatusLine(state);
  if (!line) return null;
  return state?.phase === "outcome" && state.kind === "error" ? "Could not open the orchestrator" : line.text;
}

// Interrupted-session dismissal — pure filtering logic, apart from the strip's rendering and the
// Tauri round trip, so it is testable without mounting anything (mirrors onboardingState.ts).
//
// #6476: a dismissal is durable (config.json, via dismissedSessions.ts) and keyed on
// (project, sessionId) — a NEW dead session for the same project (a fresh orch pane handle) must
// still show even though an older session for that project stays dismissed.
import type { RestorableSession } from "./herdr";

export type DismissedSession = { project: string; sessionId: string; ts: number };

/** The Interrupted strip's actual contents: every candidate restorable session minus whichever
 *  ones are durably dismissed. */
export function visibleRestorables(
  candidates: RestorableSession[],
  dismissed: DismissedSession[],
): RestorableSession[] {
  return candidates.filter(
    c => !dismissed.some(d => d.project === c.project && d.sessionId === c.sessionId),
  );
}

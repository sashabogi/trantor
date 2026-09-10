// Interrupted-session dismissal: pure filtering, testable without mounting (mirrors
// onboardingState.ts). #6476: a dismissal is durable (config.json) and keyed on (project,
// sessionId), so a NEW dead session for the same project still shows.
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

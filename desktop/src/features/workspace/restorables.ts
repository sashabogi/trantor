// Interrupted-session dismissal: pure filtering logic apart from the strip's rendering and the
// Tauri round trip, testable without mounting anything (mirrors onboardingState.ts). #6476: a
// dismissal is durable (config.json, via dismissedSessions.ts) and keyed on (project, sessionId),
// so a NEW dead session for the same project must still show even if an older one stays dismissed.
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

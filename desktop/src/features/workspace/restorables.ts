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

/** #7269 — one settle pass of the strip's re-poll loop. herdr's restore re-runs `claude --resume`
 *  the same second the app boots; those claudes register as live agents seconds later, so one
 *  launch snapshot reads every pane as Interrupted and stays wrong. `fresh` is the latest
 *  orch_restorables truth: a still-dead row keeps its entry, a gone row drops, #6476 dismissals filter. */
export function settleEntries(
  askProjects: ReadonlySet<string>,
  fresh: RestorableSession[],
  dismissed: DismissedSession[],
): RestorableSession[] {
  return visibleRestorables(
    fresh.filter(r => askProjects.has(r.project)),
    dismissed,
  );
}

/** Two consecutive polls agree, order-insensitively: herdr's restore has stopped changing the
 *  truth, so the settle window ends with whatever is still dead left showing. */
export function restoreSettled(
  prev: RestorableSession[] | null,
  next: RestorableSession[],
): boolean {
  const key = (rs: RestorableSession[]) =>
    rs.map(r => `${r.project}\t${r.sessionId}`).sort().join("\n");
  return prev !== null && key(prev) === key(next);
}

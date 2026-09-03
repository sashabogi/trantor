// wakeRow.ts — the sidebar's per-row wake states (#6138).
//
// One wake used to grey every other row and failures surfaced nowhere ("pressing the wake button
// does nothing"). Now only the clicked row shows the in-flight state and then the OUTCOME for a
// few seconds: woken, kickoff sent, busy, or the error. Pure state + classification, no React —
// directly unit-testable.

export type WakeRowState =
  | { phase: "running" }
  | { phase: "outcome"; kind: "woken" | "sent" | "busy" | "error"; text: string };

export type WakeOutcome = Extract<WakeRowState, { phase: "outcome" }>;

/** How long a woken / kickoff-sent / busy outcome stays on the row before it fades. The error
 *  stays until the next click — a failure is read at leisure, not on a timer. */
export const WAKE_OUTCOME_MS = 4000;

export function wakeOutcomeIsTransient(state: WakeRowState): boolean {
  return !(state.phase === "outcome" && state.kind === "error");
}

/** Map project_wake's answer to a row outcome. The Rust lines are contracts:
 *  ok "kickoff sent into idle pane X · …" — the idle-pane path (#6138);
 *  ok "project awake in pane X · …" — the reopen path (#6139);
 *  err "… busy in pane X …" — a live mid-turn orchestrator; anything else is the error text. */
export function classifyWakeOutcome(ok: string | null, err: string | null): WakeOutcome {
  if (ok !== null) {
    return { phase: "outcome", kind: ok.startsWith("kickoff sent") ? "sent" : "woken", text: ok };
  }
  const text = err ?? "wake failed";
  return { phase: "outcome", kind: /busy in pane/.test(text) ? "busy" : "error", text };
}

/** The short line under the project name; `title` carries the full Rust line for the tooltip. */
export function wakeRowLine(state: WakeRowState | undefined): { text: string; tone: "ok" | "muted" | "danger"; title?: string } | null {
  if (!state) return null;
  if (state.phase === "running") return { text: "waking…", tone: "muted" };
  switch (state.kind) {
    case "sent": return { text: "kickoff sent", tone: "ok", title: state.text };
    case "woken": return { text: "woken", tone: "ok", title: state.text };
    case "busy": return { text: "busy — the orchestrator is mid-turn", tone: "muted", title: state.text };
    case "error": return { text: "wake failed — click Wake to retry", tone: "danger", title: state.text };
  }
}

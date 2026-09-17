// wakeRow.ts: the sidebar's per-row wake states (#6138). Only the clicked row shows the in-flight
// state and then its OUTCOME for a few seconds (woken, kickoff sent, busy, or error); other
// rows stay untouched. Pure state + classification, no React, directly unit-testable.

export type WakeRowState =
  | { phase: "running" }
  // #6201 — the chain's kickoff section, refined by wake-progress events while the wake command
  // is still in flight: the idle gate that used to read as "waking…/working" silence, then the
  // send (retries included) until the chain lands.
  | { phase: "kickoff"; step: "pending" | "sent" }
  // #6842 — unseatable: the checkout is a folder of projects; a retry cannot help, the fix can.
  | { phase: "outcome"; kind: "woken" | "sent" | "busy" | "error" | "unseatable"; text: string };

export type WakeOutcome = Extract<WakeRowState, { phase: "outcome" }>;

// The kickoff section's two in-flight lines (#6201), shared with the chat header so the row and
// the header cannot drift apart mid-chain.
export const WAKE_PENDING_LINE = "kickoff pending — waiting for idle";
export const WAKE_SENT_LINE = "kickoff sent — waiting on the session";

/** How long a woken / kickoff-sent / busy outcome stays on the row before it fades. The error
 *  stays until the next click — a failure is read at leisure, not on a timer. */
export const WAKE_OUTCOME_MS = 4000;

export function wakeOutcomeIsTransient(state: WakeRowState): boolean {
  return !(state.phase === "outcome" && (state.kind === "error" || state.kind === "unseatable"));
}

/** Map project_wake's answer to a row outcome. The Rust lines are contracts: ok "kickoff sent
 *  into idle pane X · …" (#6138) and ok "project awake in pane X · …" (#6139); err "… busy in
 *  pane X …" is a live mid-turn orchestrator, err "… is a folder of projects, not a project — <fix>"
 *  is unseatable (#6842), anything else is the error text. */
export function classifyWakeOutcome(ok: string | null, err: string | null): WakeOutcome {
  if (ok !== null) {
    return { phase: "outcome", kind: ok.startsWith("kickoff sent") ? "sent" : "woken", text: ok };
  }
  const text = err ?? "wake failed";
  const kind = /busy in pane/.test(text) ? "busy" : /folder of projects/.test(text) ? "unseatable" : "error";
  return { phase: "outcome", kind, text };
}

/** The fix the unseatable refusal carries after its dash; the whole line when it has none. */
function unseatableFix(text: string): string {
  const dash = text.indexOf(" — ");
  return dash >= 0 ? `not a project — ${text.slice(dash + 3)}` : text;
}

/** The short line under the project name; `title` carries the full Rust line for the tooltip. */
export function wakeRowLine(state: WakeRowState | undefined): { text: string; tone: "ok" | "muted" | "danger"; title?: string } | null {
  if (!state) return null;
  if (state.phase === "running") return { text: "waking…", tone: "muted" };
  if (state.phase === "kickoff") {
    return state.step === "pending"
      ? { text: WAKE_PENDING_LINE, tone: "muted" }
      : { text: WAKE_SENT_LINE, tone: "muted" };
  }
  switch (state.kind) {
    case "sent": return { text: "kickoff sent", tone: "ok", title: state.text };
    case "woken": return { text: "woken", tone: "ok", title: state.text };
    case "busy": return { text: "busy — the orchestrator is mid-turn", tone: "muted", title: state.text };
    case "error": return { text: "wake failed — click Wake to retry", tone: "danger", title: state.text };
    case "unseatable": return { text: unseatableFix(state.text), tone: "danger", title: state.text };
  }
}

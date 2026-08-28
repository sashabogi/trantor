// TAKEOVER — the locked composer's one action, pure on purpose (#5495 / #5479).
//
// The inventory is Rust's `project_sessions` (docs/CONTRACT-chat-streaming.md v5): process +
// filesystem truth, no heartbeats, no hub. From it this derives THE one action a disabled
// composer offers — the #5477 doctrine extended to the biggest control: a locked state that
// names its moment instead of pretending emptiness. The branches mirror the CLI chain
// (`trantor takeover`) exactly, so the button can never offer what the chain would refuse.
import { invoke } from "@tauri-apps/api/core";

/** One row of the session inventory. `kind` is the source of evidence: "pane" = the hosted
 *  orchestrator (crew-windows orch row + herdr agent state), "terminal" = an interactive claude
 *  whose cwd is the project dir, "seat" = a crew-runner process. */
export type SessionRow = {
  kind: "pane" | "terminal" | "seat";
  pid: number | null;
  sessionId: string | null;
  state: string | null;
  activeAgoSec: number | null;
  transcript: string | null;
};
export type ProjectSessions = { sessions: SessionRow[] };

/** The one action the locked composer (or the Workspace empty state) offers. `why` is the
 *  sentence shown beside the button — and AS the button's title while it is disabled. */
export type TakeoverAction = { label: string; enabled: boolean; why: string };

/** A takeover may be offered once the newest transcript has been quiet this long — the same 15s
 *  the CLI's idle gate refuses under. Two claudes cannot share one transcript: the terminal one
 *  must EXIT before the pane resumes its id, and killing a mid-turn claude destroys in-flight
 *  work. 15 IS idle here, exactly as <15 IS refused there. */
export const TAKEOVER_IDLE_AFTER_SEC = 15;

// herdr only lists agents it vouches for, so these statuses are the closed not-live set — the
// same verdict sessionLiveness() applies to the pane (streaming.ts). A null state vouches for
// nothing either, which makes it dead for offering purposes: the CLI re-checks everything
// anyway, so an over-eager Reopen costs a refusal, never a wrong kill.
const CLOSED = new Set(["none", "unknown", ""]);

/** The newest terminal session by transcript freshness — the conversation takeover targets.
 *  Nulls (a claude with no transcript activity in the last hour) sort LAST: unknown freshness
 *  is the opposite of fresh. Null when there is no terminal row at all. */
export function newestTerminal(sessions: ProjectSessions | null): SessionRow | null {
  if (!sessions) return null;
  const terms = sessions.sessions.filter(s => s.kind === "terminal");
  if (!terms.length) return null;
  return terms.reduce((a, b) => ((b.activeAgoSec ?? Infinity) < (a.activeAgoSec ?? Infinity) ? b : a));
}

/** Derive the composer's one action from the inventory (#5495 / #5479). Null = no offer:
 *  either a live pane already runs the conversation (nothing to take over), or the inventory
 *  has not been read (no evidence, no action — an unread state never wears a button). */
export function takeoverAction(sessions: ProjectSessions | null): TakeoverAction | null {
  if (!sessions) return null;
  const rows = sessions.sessions;

  // A pane whose agent herdr vouches for is a live conversation — nothing to take over.
  const paneLive = rows.some(r => r.kind === "pane" && r.state !== null && !CLOSED.has(r.state.toLowerCase()));
  if (paneLive) return null;

  // The terminal branch leads, exactly as the CLI chain checks it first.
  const terms = rows.filter(r => r.kind === "terminal");
  const term = newestTerminal(sessions);
  if (term) {
    // Two fresh conversations are never guessed between silently: the NEWEST preselects and
    // the why says so — the adopt display's rule, one click instead of a flag.
    const ofMany = terms.length > 1 ? ` · newest of ${terms.length} conversations` : "";
    if (term.activeAgoSec !== null && term.activeAgoSec < TAKEOVER_IDLE_AFTER_SEC) {
      return {
        label: "Continue this conversation in Trantor",
        enabled: false,
        why: `it's mid-turn — takeover waits for a turn boundary${ofMany}`,
      };
    }
    const age = term.activeAgoSec === null
      ? "quiet for over an hour"
      : `last active ${term.activeAgoSec}s ago`;
    return {
      label: "Continue this conversation in Trantor",
      enabled: true,
      why: `running in a Terminal window · ${age}${ofMany}`,
    };
  }

  if (rows.some(r => r.kind === "pane")) {
    // The orch row exists but no agent is vouched for: the empty-pane heal, a plain reopen.
    return { label: "Reopen", enabled: true, why: "the pane's agent exited" };
  }

  // Nothing at all — seats do not count, they are workers, not the conversation.
  return { label: "Start the orchestrator here", enabled: true, why: "no session is running for this project" };
}

/** Read the project's session inventory (Rust `project_sessions`, JSON per the v5 interface
 *  contract). JSON.parse's `any` flows into ProjectSessions without a cast — the same boundary
 *  herdr.ts documents for herdr_seats(): Rust owns validation; a malformed payload throws. */
export async function projectSessions(project: string): Promise<ProjectSessions> {
  return JSON.parse(await invoke<string>("project_sessions", { project }));
}

/** Run the takeover chain in the pane (Rust `takeover_now` shells `trantor takeover --json`).
 *  A refusal — mid-turn, ambiguity — rejects with the CLI's one-line reason, which the caller
 *  shows VERBATIM: never retried, never forced from the app. */
export async function takeoverNow(project: string): Promise<string> {
  return invoke<string>("takeover_now", { project });
}

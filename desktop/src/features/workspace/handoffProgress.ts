// The Workspace's read on a running handoff chain (#6081). Rust marks the project for the whole
// chain — handoff write (~50s of summarizing), idle gate, kill, reopen, kickoff — so the pane
// tab can say the session is doomed before anyone types into it (the 21:46 drill: the operator
// typed at :07 and the doomed session's answer never existed). One invoke + one event name,
// both owned by lib.rs handoff_now.
import { invoke } from "@tauri-apps/api/core";

export const HANDOFF_PROGRESS_EVENT = "handoff-progress";

export type HandoffProgress = { project: string; active: boolean };

/** The projects with a handoff chain in flight. Queried on mount — an event alone would race
 *  a lens switch mid-chain, so the mount-time truth comes from Rust state, and the event keeps
 *  it current afterwards. */
export async function handoffInProgress(): Promise<string[]> {
  return invoke<string[]>("handoff_in_progress");
}

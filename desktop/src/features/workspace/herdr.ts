// The WORKSPACE lens's one bridge to Rust: codex's FROZEN herdr commands (#5366). The shapes
// below are the contract — if they ever need to change, that is a conversation with the
// architect, not an edit here.
//
// herdr_seats() parses ~/.agent-bus/herdr-windows.txt down to [{project, agent, surface}] (rows
// are TAB-separated `PROJECT\tKIND\tAGENT\tHANDLE`, KIND=="herdr" only, last row per
// (project, agent) wins). herdr_pane_read(pane_id) returns the pane's recent output as one
// string, which is what the read-only xterm mirror renders.
import { invoke } from "@tauri-apps/api/core";

export type HerdrSeat = { project: string; agent: string; surface: string };

/** JSON.parse's `any` flows into HerdrSeat[] without a cast — the same pattern client.ts
 * documents for doctor()/cardCode(). Rust owns validation; a malformed payload throws here. */
export async function herdrSeats(): Promise<HerdrSeat[]> {
  return JSON.parse(await invoke<string>("herdr_seats"));
}

export async function herdrPaneRead(paneId: string): Promise<string> {
  return invoke<string>("herdr_pane_read", { paneId });
}

/** The herdr surface running `agent`'s seat on `project`, or null when none exists — null is
 * the caller's cue to keep the stated-placeholder ghost, not to error. */
export async function surfaceFor(project: string, agent: string): Promise<string | null> {
  const seats = await herdrSeats();
  // Last row per (project, agent) already wins Rust-side; take the last match defensively.
  const mine = seats.filter(s => s.project === project && s.agent === agent);
  return mine.length ? (mine[mine.length - 1].surface ?? null) : null;
}

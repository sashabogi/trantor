// The REVIEW lens's one bridge to Rust: codex's FROZEN seat_diff command (#5366). The shape
// below is the contract — if it ever needs to change, that is a conversation with the architect,
// not an edit here.
import { invoke } from "@tauri-apps/api/core";

export type SeatDiffFile = {
  path: string;
  /** numstat counts — null for untracked files (git has nothing to count yet). */
  plus: number | null;
  minus: number | null;
  untracked: boolean;
};

export type SeatDiff = {
  branch: string;
  base: string;
  files: SeatDiffFile[];
  patch: string;
  /** seat_diff caps the patch at 400KB; when capped, the diff rendered is PARTIAL. */
  truncated?: boolean;
};

/** JSON.parse's `any` flows into SeatDiff without a cast — the same pattern client.ts documents
 * for doctor()/cardCode(). The Rust side owns validation; a malformed payload throws here, and
 * the lens renders its error state rather than a half-parsed diff. */
export async function seatDiff(project: string, agent: string): Promise<SeatDiff> {
  return JSON.parse(await invoke<string>("seat_diff", { project, agent }));
}

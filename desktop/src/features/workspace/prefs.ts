// Workspace panel preferences — the record rail's folded state (#5593). The operator's read:
// the rail is a LOG, not a live surface, and a log does not get 296px of every workspace by
// default right. Same persistence idiom as the chat's prefs (that module owns the hardened
// Store/domStore boundary; this one only borrows it — storage bytes are decoded, never trusted).
import { domStore, type Store } from "../chat/prefs";

const RAIL_KEY = "trantor.workspace.rail";

/** CLOSED unless the operator opened it. The first cut defaulted open "for discoverability"
 *  and the operator's screenshot answered that: at laptop width the rail dwarfed the terminal
 *  it sits beside ("a log being bigger than the terminal itself is just dumb", 2026-08-30).
 *  A log's resting state is folded; the labeled edge control IS the discoverability. */
export function loadRailOpen(store: Store | null = domStore()): boolean {
  try { return store?.getItem(RAIL_KEY) === "1"; } catch { return false; }
}

export function saveRailOpen(open: boolean, store: Store | null = domStore()): void {
  try { store?.setItem(RAIL_KEY, open ? "1" : "0"); } catch { /* refusing store — this session only */ }
}

// Workspace panel preferences — the record rail's folded state (#5593). The operator's read:
// the rail is a LOG, not a live surface, and a log does not get 296px of every workspace by
// default right. Same persistence idiom as the chat's prefs (that module owns the hardened
// Store/domStore boundary; this one only borrows it — storage bytes are decoded, never trusted).
import { domStore, type Store } from "../chat/prefs";

const RAIL_KEY = "trantor.workspace.rail";

/** Open unless the operator folded it — absence means "never touched", and the default stays
 *  open so the rail remains discoverable; folding is the deliberate act that persists. */
export function loadRailOpen(store: Store | null = domStore()): boolean {
  try { return store?.getItem(RAIL_KEY) !== "0"; } catch { return true; }
}

export function saveRailOpen(open: boolean, store: Store | null = domStore()): void {
  try { store?.setItem(RAIL_KEY, open ? "1" : "0"); } catch { /* refusing store — this session only */ }
}

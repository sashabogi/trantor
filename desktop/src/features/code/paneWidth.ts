// The mode pane's drag-resizable width (#6086) — pure clamp + persistence, so each mode comes
// back the width you left it. The pane root in ModePane renders this width, and the #6036
// observers already watch that root, so a live drag re-fits the tab strip with no extra wiring.
//
// Storage rides the same injected Store the chat prefs use (#5522) — siblings under the
// "trantor." prefix. Every reader is total: a missing, corrupted, foreign or REFUSING store
// falls back to the default rather than to a crash or a silently wrong size. Storage is a
// boundary; its bytes are decoded, never trusted.
import { domStore, type Store } from "../chat/prefs";

export type PaneMode = "files" | "git" | "sessions" | "chat";

/** The designed widths — the artboard truth ModePane rendered before dragging existed, and the
 *  state a double-click reset returns to. */
export const PANE_DEFAULT = { files: 300, git: 300, sessions: 300, chat: 440 } satisfies Record<PaneMode, number>;

/** The drag contract (#6086): never narrower than a readable pane, never wider than 60% of the
 *  window — the center surface narrows, it never disappears. */
export const PANE_MIN = 280;
export const PANE_MAX_FRAC = 0.6;

/** One arrow press on the focused splitter moves the edge this many px. */
export const PANE_STEP = 16;

/** What the row around the pane needs besides the pane itself (#6036 drill): the 240px nav
 *  aside + the pane's 12px margins both sides + its 2px border. A pane wider than
 *  window − this never overflows the row, so the strip genuinely narrows with the window and
 *  the tab observers see the resize — the window edge must never clip the pane instead. */
export const PANE_ROW_RESERVED = 266;

export function paneMax(windowWidth: number): number {
  return Math.floor(windowWidth * PANE_MAX_FRAC);
}

/** The window's width, or NaN where there is no window (tests, embeddings) — clampPaneWidth
 *  reads NaN as "the cap cannot apply", because there is no surface to take from. */
export function windowWidthNow(): number {
  try {
    const w = globalThis.innerWidth;
    return Number.isFinite(w) ? w : NaN;
  } catch {
    return NaN;
  }
}

export function clampPaneWidth(px: number, windowWidth: number): number {
  const w = Math.round(px);
  // No usable window dimension: the floor still applies, the cap cannot.
  if (!Number.isFinite(windowWidth)) return Math.max(PANE_MIN, w);
  // On a degenerate window (max < min) the MIN wins: a readable pane beats the 60% cap where
  // the cap itself would make the pane unreadable. Real windows never get here.
  return Math.max(PANE_MIN, Math.min(paneMax(windowWidth), w));
}

const widthKey = (mode: PaneMode): string => `trantor.pane.width.${mode}`;

/** The stored width for one mode, or null when never dragged, cleared, or unreadable. A stored
 *  out-of-range number is clamped on read: storage is somebody else's bytes, the pane's shape
 *  is this module's contract. */
export function loadPaneWidth(mode: PaneMode, store: Store | null = domStore(), windowWidth: number = windowWidthNow()): number | null {
  let raw: string | null;
  try { raw = store?.getItem(widthKey(mode)) ?? null; } catch { return null; }
  if (raw === null || raw === "none") return null;
  // An empty string Numbers to 0 — that is corruption (every value this module writes has
  // digits), not a wish for a 0px pane, so it reads as never-set like any other foreign byte.
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? clampPaneWidth(n, windowWidth) : null;
}

export function savePaneWidth(mode: PaneMode, px: number, store: Store | null = domStore(), windowWidth: number = windowWidthNow()): void {
  try { store?.setItem(widthKey(mode), String(clampPaneWidth(px, windowWidth))); } catch { /* a refusing store keeps this session's choice in memory only */ }
}

/** Double-click reset (#6086): the stored choice is CLEARED, not overwritten — the pane returns
 *  to its designed default. The two-method Store seam has no removeItem, so "cleared" rides the
 *  same "none" sentinel prefs.ts's dismissedAt uses; loadPaneWidth decodes it back to null. */
export function clearPaneWidth(mode: PaneMode, store: Store | null = domStore()): void {
  try { store?.setItem(widthKey(mode), "none"); } catch { /* a refusing store has nothing to forget */ }
}

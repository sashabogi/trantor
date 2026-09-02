// The composer's height (#6070): freely resizable between two lines and about 60% of the pane,
// auto-growing with content, the chosen height remembered across restarts.
//
// Two rules, both pure so they can be drilled without a DOM: GROWTH (content decides the height
// within the pane's bounds — the state before any drag) and CHOICE (a drag sets an explicit height
// the box holds; content taller than it scrolls inside). Persistence follows prefs.ts' seam: the
// store is injected and defaults to the DOM's own storage, every reader total — a missing,
// corrupted or REFUSING store falls back to "never resized", storage bytes are decoded, never
// trusted.

import { domStore, type Store } from "./prefs";

/** text-[12.5px] at leading-relaxed is 1.625 × 12.5 ≈ 20.5px a line; p-2.5 is 10px top + bottom.
 *  The textarea's designed metrics — the minimum height is two of those lines. */
export const COMPOSER_LINE_PX = 20.5;
export const COMPOSER_PAD_PX = 20;

export function minComposerPx(): number {
  return Math.round(2 * COMPOSER_LINE_PX + COMPOSER_PAD_PX);
}

/** The ceiling is 60% of the pane the composer sits in — the transcript is the panel's job, and
 *  the input must never evict it. Never below the floor, so a tiny pane still gets two lines. */
export function maxComposerPx(panePx: number): number {
  return Math.max(minComposerPx(), Math.round(panePx * 0.6));
}

export function clampComposerPx(px: number, minPx: number, maxPx: number): number {
  return Math.min(maxPx, Math.max(minPx, Math.round(px)));
}

/** Auto-grow: content decides the height within the bounds. This is only the UNCHOSEN state — once
 *  the operator drags, the chosen height overrides growth until they drag again. */
export function growComposerPx(contentPx: number, minPx: number, maxPx: number): number {
  return clampComposerPx(contentPx, minPx, maxPx);
}

const HEIGHT_KEY = "trantor.chat.composerHeight";

/** The remembered height, or null when nothing was ever dragged. A stored out-of-range number is
 *  clamped on read — storage is somebody else's bytes and the pane's shape is this module's
 *  contract; garbage reads as never-set. */
export function loadComposerHeight(minPx: number, maxPx: number, store: Store | null = domStore()): number | null {
  let raw: string | null;
  try { raw = store?.getItem(HEIGHT_KEY) ?? null; } catch { return null; }
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? clampComposerPx(n, minPx, maxPx) : null;
}

export function saveComposerHeight(px: number, minPx: number, maxPx: number, store: Store | null = domStore()): void {
  try { store?.setItem(HEIGHT_KEY, String(clampComposerPx(px, minPx, maxPx))); } catch { /* refusing store — this session only */ }
}

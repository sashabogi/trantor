// Chat panel preferences — the reading-comfort dials (#5522) and the terminal tray's folded
// state (#5523), pure and persisted so the panel comes back as you left it.
//
// localStorage is the store AppShell already uses for this panel's open/dock state
// ("trantor.chat.open", "trantor.chat.dock"); these are siblings under the same prefix. The
// store is injected the way TerminalDeps injects the pane's reach — the functions default to
// the DOM's own storage, and every reader is total: a missing, corrupted, foreign or REFUSING
// store falls back to the default rather than to a crash or a silently wrong size. Storage is
// a boundary; its bytes are decoded, never trusted.

/** The two-method surface localStorage has always had, narrowed so tests (and any embedding)
 *  can supply a faithful stand-in instead of a mocked global. */
export type Store = { getItem(key: string): string | null; setItem(key: string, value: string): void };

/** The DOM's own storage, reached lazily so importing this module never touches the window.
 *  Null when there is none or when it refuses to be read (private mode; some embeddable
 *  windows throw on access itself) — callers treat null as "nothing was ever persisted". */
export function domStore(): Store | null {
  try {
    const ls = globalThis.localStorage;
    return ls ? { getItem: k => ls.getItem(k), setItem: (k, v) => { ls.setItem(k, v); } } : null;
  } catch {
    return null;
  }
}

export type FontStep = "s" | "m" | "l";

/** The three reading sizes (#5522) as multipliers of the transcript's designed sizes. The chat
 *  root carries the chosen number as the `--chat-scale` custom property; only this panel's own
 *  transcript reads it, so M (exactly 1) IS the designed size and nothing global moves. */
export const FONT_SCALE = { s: 0.9, m: 1, l: 1.15 } satisfies Record<FontStep, number>;

export const FONT_STEPS: Array<{ step: FontStep; label: string }> = [
  { step: "s", label: "S" },
  { step: "m", label: "M" },
  { step: "l", label: "L" },
];

const FONT_KEY = "trantor.chat.font";

export function loadFontStep(store: Store | null = domStore()): FontStep {
  // The closed set checked by identity, not a substring guess: only a value this module
  // wrote counts, everything else reads as "never set".
  const raw = (() => { try { return store?.getItem(FONT_KEY) ?? null; } catch { return null; } })();
  return raw === "s" || raw === "l" ? raw : "m";
}

export function saveFontStep(step: FontStep, store: Store | null = domStore()): void {
  try { store?.setItem(FONT_KEY, step); } catch { /* a refusing store keeps this session's choice in memory only */ }
}

export function fontScale(step: FontStep): number {
  return FONT_SCALE[step];
}

/** The panel's sane size range per axis (#5522). Width is the right dock's cross-size, height
 *  the bottom dock's: below the minimum the transcript stops reading, above the maximum the
 *  chat stops being a panel and takes the surface it sits beside. */
export const PANEL_RANGE = {
  width: [320, 720],
  height: [220, 640],
} satisfies Record<"width" | "height", [number, number]>;

export function clampPanel(px: number, axis: "width" | "height"): number {
  const [min, max] = PANEL_RANGE[axis];
  return Math.min(max, Math.max(min, Math.round(px)));
}

/** The persisted size for one axis, or null when none was ever dragged — the caller then uses
 *  its designed default. A stored out-of-range number is clamped on read, because storage is
 *  somebody else's bytes and the panel's shape is this module's contract. */
export function loadPanelSize(axis: "width" | "height", store: Store | null = domStore()): number | null {
  let raw: string | null;
  try { raw = store?.getItem(`trantor.chat.${axis}`) ?? null; } catch { return null; }
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? clampPanel(n, axis) : null;
}

export function savePanelSize(axis: "width" | "height", px: number, store: Store | null = domStore()): void {
  try { store?.setItem(`trantor.chat.${axis}`, String(clampPanel(px, axis))); } catch { /* refusing store — this session only */ }
}

const TRAY_KEY = "trantor.chat.tray";

/** The terminal tray starts FOLDED (#5523): the transcript is the panel's job, and the live
 *  terminal is something you open on purpose. Absent or unreadable storage keeps it folded. */
export function loadTrayOpen(store: Store | null = domStore()): boolean {
  try { return store?.getItem(TRAY_KEY) === "1"; } catch { return false; }
}

export function saveTrayOpen(open: boolean, store: Store | null = domStore()): void {
  try { store?.setItem(TRAY_KEY, open ? "1" : "0"); } catch { /* refusing store — this session only */ }
}

const DISMISSED_KEY = "trantor.chat.handoff.dismissedAt";

/** The frac the handoff banner was last dismissed at (#5509 W1), or null when nothing was ever
 *  dismissed. An EPISODE marker, not a timestamp: it parks the re-offer until frac has grown
 *  another step, and a session change clears it (a new window is a new episode). Absent, foreign
 *  or negative bytes read as "never dismissed" — storage is a boundary, its bytes are decoded. */
export function loadDismissedAt(store: Store | null = domStore()): number | null {
  let raw: string | null;
  try { raw = store?.getItem(DISMISSED_KEY) ?? null; } catch { return null; }
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function saveDismissedAt(frac: number | null, store: Store | null = domStore()): void {
  // The seam's two-method store has no removeItem, so "cleared" is written as a sentinel that
  // loadDismissedAt decodes back to null (Number("none") is NaN).
  try { store?.setItem(DISMISSED_KEY, frac === null ? "none" : String(frac)); } catch { /* refusing store — this session only */ }
}

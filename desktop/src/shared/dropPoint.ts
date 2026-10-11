// Maps a Tauri drop payload position to CSS px. macOS wry hands over AppKit points (CSS px)
// that tauri-runtime-wry stamps PhysicalPosition (wry-0.55.1 wkwebview/drag_drop.rs:87), so
// the /dpr the callers assumed halved every hit into the pane left of the cursor (#11513).
// A point inside the window is already CSS px; only a true physical coordinate lands outside it.
export function dropPointToCss(position: { x: number; y: number }) {
  const inside = position.x <= window.innerWidth && position.y <= window.innerHeight;
  if (inside) return position;
  const dpr = window.devicePixelRatio || 1;
  return { x: position.x / dpr, y: position.y / dpr };
}

// The hit's one-line identity for the drop trace: tag plus the data attrs a handler's verdict
// names, so the operator's next drop reads as "CANVAS[data-pane=pane-1]" rather than "[object]".
export function describeHit(hit: Element | null): string {
  if (!hit) return "null";
  const attrs = ["data-testid", "data-pane", "data-modal-sheet-open"]
    .map(a => hit.getAttribute(a)).filter(Boolean).map(a => `[${a}]`).join("");
  return `${hit.tagName.toLowerCase()}${attrs}`;
}

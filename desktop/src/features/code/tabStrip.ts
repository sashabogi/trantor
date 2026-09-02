// The mode rail's width→layout decision (#6036): a tab word NEVER truncates. Operator evidence
// at a narrow right pane: the strip read "Files · Git · Ses… · C…" and the active tab was
// unreadable. So the strip has exactly two honest states — full labels when the measured width
// fits all four ("Files · Git · Sessions · Chat" at 11.5px + icon + the chat's unread dot, with
// grid quarters per #5960 — 288px of strip content is the measured fit line), and icon-only tabs
// with the label as tooltip below it. The decision is pure so the boundary is pinned by a test;
// the component only supplies the ResizeObserver measurement. An unmeasured width stays on
// labels — the designed default never degrades on a guess.
export const TAB_LABELS_MIN_WIDTH = 288;

export type TabsMode = "labels" | "icons";

export function tabsMode(widthPx: number | null | undefined): TabsMode {
  if (widthPx == null) return "labels";
  return widthPx >= TAB_LABELS_MIN_WIDTH ? "labels" : "icons";
}

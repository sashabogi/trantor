// The mode rail's width→layout decision (#6036): a tab word NEVER truncates. Operator evidence
// at a narrow right pane: the strip read "Files · Git · Ses… · C…" anyway — the old hardcoded
// 288px "measured fit line" was not the truth of the labels. Fonts, padding and the unread dot
// decide, so the component MEASURES both sides and this function only compares them:
//   · labelsWidth — the natural width of the tab row with all four FULL labels (an offscreen
//     twin of the labeled tabs at the strip's own font, measured by the component);
//   · stripWidth — the space the strip actually has (its clientWidth, the pane willing).
// Icon-only when the labels would not fit; back to labels only once they fit with a few px to
// spare — the band between "does not fit" and "fits comfortably" is hysteresis, so a strip
// sitting at the boundary cannot flicker both ways on a 1px drag. `current` carries the mode
// across calls; pinned around equality by test. An unmeasured strip stays on labels — the
// designed default never degrades on a guess.
export const TABS_HYSTERESIS_PX = 4;

export type TabsMode = "labels" | "icons";

export function tabsMode(
  labelsWidth: number | null | undefined,
  stripWidth: number | null | undefined,
  current: TabsMode = "labels",
): TabsMode {
  if (labelsWidth == null || stripWidth == null) return "labels";
  if (current === "icons") return labelsWidth <= stripWidth - TABS_HYSTERESIS_PX ? "labels" : "icons";
  return labelsWidth <= stripWidth ? "labels" : "icons";
}

// The mode rail's width→layout decision (#6036): a tab word NEVER truncates. Operator evidence
// at a narrow right pane: the strip read "Files · Git · Ses… · C…" anyway — first because a
// hardcoded 288px "measured fit line" was not the truth of the labels, and after the first fix
// because the twin that measured the labels was styled by Tailwind utilities while the REAL
// tabs are styled by unlayered `.tr-seg > button` CSS that beats every utility — padding 12px
// a side, 12px font. The twin under-measured by ~60px and the strip kept labels it could not
// fit (operator drill 09-03). So the component measures what the cascade actually renders:
//   · stripLabelsNeed — the natural width of the labeled tab row, built from twin tab BUTTONS
//     that sit as direct children of the real strip (so `.tr-seg > button` styles them exactly
//     like the real tabs) plus the strip's own computed gap and side padding;
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

/** The width the four LABELED tabs need, read off the live strip (#6036): each twin button's
 *  full rect (it shrink-wraps its icon + word + dot — nothing inside can wrap or truncate),
 *  plus the strip's real inter-tab gap and side padding from computed style, which is where
 *  the cascade's truth lives. Null when there is nothing to measure — the caller stays on
 *  labels rather than degrade on a guess. */
export function stripLabelsNeed(strip: HTMLElement | null): number | null {
  if (!strip) return null;
  const twins = strip.querySelectorAll<HTMLButtonElement>("button[data-twin='true']");
  if (twins.length === 0) return null;
  const cs = getComputedStyle(strip);
  const gap = Number.parseFloat(cs.columnGap) || 0;
  const padX = (Number.parseFloat(cs.paddingLeft) || 0) + (Number.parseFloat(cs.paddingRight) || 0);
  let need = padX;
  twins.forEach((b, i) => {
    if (i > 0) need += gap;
    need += b.getBoundingClientRect().width;
  });
  return need;
}

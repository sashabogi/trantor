// The mode rail's width->layout decision (#6036): a tab word NEVER truncates. Twin tab buttons must
// sit as direct children of the real strip so unlayered `.tr-seg > button` CSS styles them exactly
// like the real tabs (a Tailwind-styled twin under-measures and lets untruncated labels overflow).
// Icon-only below fit, labels above fit-plus-margin: that hysteresis band stops 1px-drag flicker.
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

/** The width the four LABELED tabs need, read off the live strip (#6036): each twin button's full
 *  shrink-wrapped rect (icon + word + dot, nothing wraps or truncates) plus the strip's real gap
 *  and side padding from computed style. Null when there is nothing to measure; caller stays on
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

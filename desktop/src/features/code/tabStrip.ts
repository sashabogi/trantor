// The mode rail's width→layout decision (#6036): a tab word NEVER truncates. A hardcoded fit line and
// a utility-styled twin both lied (unlayered `.tr-seg > button` CSS beats every utility), so the
// component measures what the cascade renders: stripLabelsNeed (twin BUTTONS inside the real strip)
// vs stripWidth. Icon-only when labels would not fit, back with hysteresis; unmeasured stays on labels.
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
 *  rect plus the strip's real gap and side padding from computed style. Null when there is nothing
 *  to measure; the caller stays on labels rather than degrade on a guess. */
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

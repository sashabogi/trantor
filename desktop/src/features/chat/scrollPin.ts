// Stick-to-bottom for the transcript (#6697). The operator reads a long reply while the session
// keeps writing; the old effect scrolled to the foot on every appended turn, so each new line
// yanked the view down and they scrolled back up, again and again. The rule the common chat
// pattern uses: the view follows new content ONLY while it is already at the bottom. Scroll up
// and it stays where you left it; a jump-to-latest button brings you back and re-pins.
//
// Pure on purpose: the geometry check is the whole decision, and it drills without a DOM.

/** How far from the foot still counts as "at the bottom". A smooth scroll settles a pixel or two
 *  short, and the operator nudging the wheel a hair must not silently unpin them. */
export const PIN_THRESHOLD_PX = 40;

export type ScrollMetrics = { scrollHeight: number; scrollTop: number; clientHeight: number };

/** True when the viewport sits within the threshold of the foot — content shorter than the
 *  viewport is always pinned (there is nowhere else to be). */
export function isPinned(m: ScrollMetrics, threshold = PIN_THRESHOLD_PX): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= threshold;
}

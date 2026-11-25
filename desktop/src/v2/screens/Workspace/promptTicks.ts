// Pure model for the prompt timeline: one tick per operator message, never any invented detail (#14075).

export type PromptItem = { id: string; text: string; ts?: number };

const WORDS = 8;

/** Reads the prompt id, text and optional send time off the DOM elements the chat marks (#14075). */
export function readPrompts(els: ReadonlyArray<Element>): PromptItem[] {
  const out: PromptItem[] = [];
  for (const el of els) {
    const id = el.getAttribute("data-prompt-id");
    const text = (el.textContent ?? "").trim();
    if (!id || !text) continue;
    const raw = Number(el.getAttribute("data-prompt-ts"));
    out.push(Number.isFinite(raw) && raw > 0 ? { id, text, ts: raw } : { id, text });
  }
  return out;
}

/** The accessible name of one tick: its place in the conversation and the first words of the prompt. */
export function tickLabel(index: number, total: number, text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const head = words.slice(0, WORDS).join(" ");
  return `Prompt ${index + 1} of ${total}: ${head}${words.length > WORDS ? "..." : ""}`;
}

/** Index of the last prompt whose top is at or above the viewport top (plus slack), else the first one. */
export function activeIndex(tops: ReadonlyArray<number>, slack = 8): number {
  let active = 0;
  tops.forEach((top, i) => { if (top <= slack) active = i; });
  return active;
}

/** A column with fewer than two prompts has nothing to navigate, so it is not rendered. */
export const showsTimeline = (count: number): boolean => count >= 2;

/** Whether two prompt lists would draw the same column, so a streaming mutation does not re-render it. */
export function samePrompts(a: ReadonlyArray<PromptItem>, b: ReadonlyArray<PromptItem>): boolean {
  return a.length === b.length && a.every((p, i) => p.id === b[i].id && p.text === b[i].text && p.ts === b[i].ts);
}

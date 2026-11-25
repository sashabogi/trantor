// Pure model for the prompt timeline: one tick per operator message, never any invented detail (#14075).

export type PromptItem = { id: string; text: string; ts?: number; files?: string[] };

const WORDS = 8;

/** The prompt's changed files off one DOM element: a JSON array of paths (#14084). Absent,
 *  empty or malformed leaves undefined, so the card draws no line rather than a guess. */
function filesOf(el: Element): string[] | undefined {
  const raw = el.getAttribute("data-prompt-files");
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    // Same boundary rule as readExpanded (useExplorerData): the writer is our own Chat, so the
    // array shape is checked and each entry is taken as its string form.
    if (!Array.isArray(parsed)) return undefined;
    const files = parsed.map(String).filter(f => f.length > 0);
    return files.length ? files : undefined;
  } catch { return undefined; }
}

/** Reads the prompt id, text, optional send time and changed files off the DOM elements the
 *  chat marks (#14075, #14084). */
export function readPrompts(els: ReadonlyArray<Element>): PromptItem[] {
  const out: PromptItem[] = [];
  for (const el of els) {
    const id = el.getAttribute("data-prompt-id");
    const text = (el.textContent ?? "").trim();
    if (!id || !text) continue;
    const item: PromptItem = { id, text };
    const raw = Number(el.getAttribute("data-prompt-ts"));
    if (Number.isFinite(raw) && raw > 0) item.ts = raw;
    const files = filesOf(el);
    if (files) item.files = files;
    out.push(item);
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

/** Whether two prompt lists would draw the same column and cards, so a streaming mutation does
 *  not re-render it: files grow while a reply streams, so they are part of the comparison. */
export function samePrompts(a: ReadonlyArray<PromptItem>, b: ReadonlyArray<PromptItem>): boolean {
  const sameFiles = (x: string[] | undefined, y: string[] | undefined): boolean =>
    x === y || (x !== undefined && y !== undefined && x.length === y.length && x.every((p, i) => p === y[i]));
  return a.length === b.length && a.every((p, i) => p.id === b[i].id && p.text === b[i].text && p.ts === b[i].ts && sameFiles(p.files, b[i].files));
}

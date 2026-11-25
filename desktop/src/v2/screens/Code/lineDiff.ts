// A line diff for the change markers: which lines of the new text were added or changed, and
// where lines were taken away. Pure, so it is tested without Monaco.
export type MarkKind = "added" | "changed" | "removed";
/** Lines are 1-based and inclusive. A removed run sits on the line that now follows the gap. */
export type MarkRun = { kind: MarkKind; from: number; to: number };

/** The table for the differing middle may hold at most this many cells; above it, no markers. */
export const MAX_DIFF_CELLS = 4_000_000;

export const splitLines = (text: string): string[] => text.split(/\r\n|\n/);

/** Returns null when the two sides differ too much to diff cheaply. */
export function diffLines(oldText: string, newText: string): MarkRun[] | null {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n === 0 && m === 0) return [];
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) return null;

  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[head + i] === b[head + j]
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const runs: MarkRun[] = [];
  let deleted = 0;
  let inserted = 0;
  let gapStart = 0;
  const flush = (at: number) => {
    // `at` is the 0-based index in the new middle where the gap ended.
    const paired = Math.min(deleted, inserted);
    const first = head + gapStart;
    if (paired > 0) runs.push({ kind: "changed", from: first + 1, to: first + paired });
    if (inserted > paired) runs.push({ kind: "added", from: first + paired + 1, to: head + at });
    if (deleted > paired) runs.push({ kind: "removed", from: head + at + 1, to: head + at + 1 });
    deleted = 0;
    inserted = 0;
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[head + i] === b[head + j]) {
      flush(j);
      i++; j++; gapStart = j;
    } else if (j >= m || (i < n && lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
      deleted++; i++;
    } else {
      inserted++; j++;
    }
  }
  flush(j);
  return runs;
}

// TerminalPane's only pure logic, so it carries the pane's whole test weight: the hub of the
// flicker fix on #5367 is that a poll that returns mostly-unchanged output writes a SUFFIX, not a
// repaint. `herdr pane read` returns accumulated recent output, so successive reads are usually
// prefix-extensions of each other — and when they are not (a clear, a TUI redraw), the only honest
// move is a full replace.
export type PaneUpdate =
  | { kind: "append"; text: string }
  | { kind: "replace"; text: string };

/** What to write into the terminal so it shows `next`, given it already shows `prev`.
 *  null = already current, write nothing. */
export function paneDiff(prev: string, next: string): PaneUpdate | null {
  if (next === prev) return null;
  if (next.startsWith(prev)) {
    const suffix = next.slice(prev.length);
    if (suffix) return { kind: "append", text: suffix };
    return null;
  }
  return { kind: "replace", text: next };
}

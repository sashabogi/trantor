// #14495: the one-shot card a palette result asked the Board to open — the openIntent pattern for
// the Board lens. ShellV2 sets it before navigating; BoardScreen takes it on mount, or at once
// when it is already showing that project (watch), and opens that card's drawer.
const pending = new Map<string, number>();
const watchers = new Map<string, Set<() => void>>();

export function openBoardCard(project: string, id: number): void {
  pending.set(project, id);
  watchers.get(project)?.forEach(wake => wake());
}

/** Returns the waiting card id and clears it, so it fires once. */
export function takeBoardCard(project: string): number | null {
  const id = pending.get(project) ?? null;
  pending.delete(project);
  return id;
}

/** Calls `wake` whenever a card is asked for in that project; returns the call that stops it. */
export function watchBoardCard(project: string, wake: () => void): () => void {
  const set = watchers.get(project) ?? new Set<() => void>();
  set.add(wake);
  watchers.set(project, set);
  return () => { set.delete(wake); };
}

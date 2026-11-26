// "Open card #N" from anywhere in the 2.0 shell (#14327): a transcript link sets it, the card sheet
// mounted once in ShellV2 shows it. A tiny store, read with useSyncExternalStore.
export type OpenCard = { project: string; id: number };

let current: OpenCard | null = null;
const watchers = new Set<() => void>();

const wake = () => watchers.forEach(w => w());

export function openCardSheet(project: string, id: number): void {
  current = { project, id };
  wake();
}

export function closeCardSheet(): void {
  if (current === null) return;
  current = null;
  wake();
}

export function currentCardSheet(): OpenCard | null {
  return current;
}

/** Calls `wake` on every change; returns the call that stops it. */
export function watchCardSheet(onChange: () => void): () => void {
  watchers.add(onChange);
  return () => { watchers.delete(onChange); };
}

// #14495: the one-shot "open Messages on this sender's thread" — the 2.0 half of classic
// AppShell's inbox jump. The Inbox sets it before navigating; MessagesLens takes it on mount and
// hands it to classic Messages, which already knows how to land on (or start) that thread.
let pending: string | null = null;
const watchers = new Set<() => void>();

const wake = () => watchers.forEach(w => w());

export function openMessagesWith(session: string): void {
  pending = session;
  wake();
}

/** Returns the waiting sender and clears it, so it fires once. */
export function takeMessagesFocus(): string | null {
  const session = pending;
  pending = null;
  return session;
}

/** Calls `wake` whenever a focus is set; returns the call that stops it. */
export function watchMessagesFocus(onChange: () => void): () => void {
  watchers.add(onChange);
  return () => { watchers.delete(onChange); };
}

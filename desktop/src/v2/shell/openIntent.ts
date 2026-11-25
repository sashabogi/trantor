// A one-shot note from one lens to the next: "open this file", "show source control", "show this
// change's diff" or "show this commit" (#13987, #14044). Workspace sets it then navigates; Code
// takes it on mount, or at once when it is already showing that project.
export type OpenIntent =
  | { kind: "file"; path: string; seat?: string }
  | { kind: "source-control"; seat?: string }
  | { kind: "change"; path: string; seat?: string }
  | { kind: "commit"; sha: string; seat?: string };

const pending = new Map<string, OpenIntent>();
const watchers = new Map<string, Set<() => void>>();

export function setOpenIntent(project: string, intent: OpenIntent): void {
  pending.set(project, intent);
  watchers.get(project)?.forEach(wake => wake());
}

/** Returns the waiting intent and clears it, so it fires once. */
export function takeOpenIntent(project: string): OpenIntent | undefined {
  const intent = pending.get(project);
  pending.delete(project);
  return intent;
}

/** Calls `wake` whenever an intent is set for the project; returns the call that stops it. */
export function watchOpenIntent(project: string, wake: () => void): () => void {
  const set = watchers.get(project) ?? new Set<() => void>();
  set.add(wake);
  watchers.set(project, set);
  return () => { set.delete(wake); };
}

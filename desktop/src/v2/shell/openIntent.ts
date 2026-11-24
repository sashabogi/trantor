// A one-shot note from one lens to the next: "open this file" or "show source control" (#13987 drill).
// Workspace sets it then navigates; Code takes it on mount, so a file chosen in the files column is not dropped.
export type OpenIntent =
  | { kind: "file"; path: string; seat?: string }
  | { kind: "source-control"; seat?: string };

const pending = new Map<string, OpenIntent>();

export function setOpenIntent(project: string, intent: OpenIntent): void {
  pending.set(project, intent);
}

/** Returns the waiting intent and clears it, so it fires once. */
export function takeOpenIntent(project: string): OpenIntent | undefined {
  const intent = pending.get(project);
  pending.delete(project);
  return intent;
}

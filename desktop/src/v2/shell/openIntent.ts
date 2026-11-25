// A one-shot note from one lens to the next: "open this file", "show source control", "show this
// change's diff" or "show this commit" (#13987, #14044). Workspace sets it then navigates; Code
// takes it on mount, so a choice made in the left column is not dropped.
export type OpenIntent =
  | { kind: "file"; path: string; seat?: string }
  | { kind: "source-control"; seat?: string }
  | { kind: "change"; path: string; seat?: string }
  | { kind: "commit"; sha: string; seat?: string };

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

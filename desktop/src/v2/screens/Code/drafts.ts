// The v2 Code screen's unsaved text (#14072): the editor remounts on every tab switch, so a dirty
// draft lives here, keyed like a tab (project, scope, path). The classic lens keeps its own drafts
// in features/code; this one belongs to the v2 tab alone, and a confirmed close drops it.
const drafts = new Map<string, string>();

const key = (project: string, scope: string | null, path: string) => `${project}\u0000${scope ?? ""}\u0000${path}`;

export function draftFor(project: string, scope: string | null, path: string): string | null {
  return drafts.get(key(project, scope, path)) ?? null;
}

export function draftKeep(project: string, scope: string | null, path: string, text: string): void {
  drafts.set(key(project, scope, path), text);
}

/** A confirmed close discards the draft: the tab is the work's address, and with the tab gone the
 *  draft has no door, the same rule documents.ts applies to the classic lens's tabs. */
export function draftDrop(project: string, scope: string | null, path: string): void {
  drafts.delete(key(project, scope, path));
}

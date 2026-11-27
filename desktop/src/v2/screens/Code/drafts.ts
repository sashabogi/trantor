// The v2 Code screen's unsaved text (#14072): the editor remounts on every tab switch, so a dirty
// draft lives here, keyed like a tab (project, scope, path), with the disk text it was kept
// against (#14486) so a reopen can tell an unsaved edit from a file that changed underneath.
// #14488: the draft rides to disk (draft_persist/load/forget, debounced), baseline and all.
import { draftForget, draftLoad, draftPersist } from "../../../features/code/fileApi";

const drafts = new Map<string, { text: string; baseline?: string }>();

const key = (project: string, scope: string | null, path: string) => `${project}\u0000${scope ?? ""}\u0000${path}`;

// The companion's path key: a NUL can never occur in a real path, so the baseline's slot can
// never collide with a file's own draft, and the classic lens — which never reads it — simply
// never loads it. The baseline travels JSON-wrapped because draft_load reads an empty string as
// "no draft", and an empty file is a baseline that must survive the round trip.
const baselinePath = (path: string) => `${path}\u0000baseline`;

// #14488: one write-behind per draft, 600ms after the last keystroke — a keystroke must not cost
// a disk write, and an unmount flushes what is pending instead of waiting the window out.
const SAVE_DELAY_MS = 600;
type WriteBehind = { project: string; scope: string | null; path: string; text: string; baseline?: string };
type Pending = WriteBehind & { timer: ReturnType<typeof setTimeout> };
const pending = new Map<string, Pending>();

const fire = (p: WriteBehind) => {
  pending.delete(key(p.project, p.scope, p.path));
  void draftPersist(p.project, p.path, p.scope ?? undefined, p.text);
  // The baseline companion: without it a restart could not tell an unsaved edit from a file that
  // changed while the app was closed, and the restored draft would silently outrank the disk.
  if (p.baseline !== undefined) void draftPersist(p.project, baselinePath(p.path), p.scope ?? undefined, JSON.stringify(p.baseline));
};

export function draftFor(project: string, scope: string | null, path: string): string | null {
  return drafts.get(key(project, scope, path))?.text ?? null;
}

export function draftBaseline(project: string, scope: string | null, path: string): string | undefined {
  return drafts.get(key(project, scope, path))?.baseline;
}

export function draftKeep(project: string, scope: string | null, path: string, text: string, baseline?: string): void {
  drafts.set(key(project, scope, path), { text, baseline });
  const existing = pending.get(key(project, scope, path));
  if (existing) clearTimeout(existing.timer);
  const entry: WriteBehind = { project, scope, path, text, baseline };
  const timer = setTimeout(() => fire(entry), SAVE_DELAY_MS);
  pending.set(key(project, scope, path), { ...entry, timer });
}

/** Hold the write-behind: a save is committing this text, and a debounce still in flight would
 *  re-persist the very draft the save retires. The memory slot is untouched. */
export function draftHold(project: string, scope: string | null, path: string): void {
  const existing = pending.get(key(project, scope, path));
  if (!existing) return;
  clearTimeout(existing.timer);
  pending.delete(key(project, scope, path));
}

/** Fire this draft's pending write now — an editor unmount (tab switch, screen change) must not
 *  leave the last keystrokes waiting out the debounce window. */
export function draftFlush(project: string, scope: string | null, path: string): void {
  const existing = pending.get(key(project, scope, path));
  if (!existing) return;
  clearTimeout(existing.timer);
  fire(existing);
}

/** A confirmed close discards the draft: the tab is the work's address, and with the tab gone the
 *  draft has no door, the same rule documents.ts applies to the classic lens's tabs. #14488: the
 *  discard also retires the persisted copy and its baseline, so a reopen starts from the disk,
 *  not the ghost. */
export function draftDrop(project: string, scope: string | null, path: string): void {
  drafts.delete(key(project, scope, path));
  draftHold(project, scope, path);
  void draftForget(project, path, scope ?? undefined);
  void draftForget(project, baselinePath(path), scope ?? undefined);
}

/** The draft to resume editing with (#14488): the memory slot first (a tab switch), then the disk
 *  copy the last exit persisted (a restart) — and a disk hit owns the memory slot, baseline
 *  included, so the reopen checks the draft against the disk the way a tab switch's slot does: a
 *  file that changed while the app was closed raises the notice, never a silent win. */
export async function draftResume(project: string, scope: string | null, path: string): Promise<string | null> {
  const kept = draftFor(project, scope, path);
  if (kept !== null) return kept;
  const onDisk = await draftLoad(project, path, scope ?? undefined);
  if (onDisk === null) return null;
  // SAFETY: encodeBaseline wrote a JSON string; String() normalizes whatever a hand-edited
  // companion holds, and the catch retires one that is not JSON — either way it checks nothing
  // rather than lying about the disk it was kept against.
  const raw = await draftLoad(project, baselinePath(path), scope ?? undefined);
  let baseline: string | undefined;
  if (raw !== null) {
    try { baseline = String(JSON.parse(raw) ?? ""); } catch { baseline = undefined; }
  }
  drafts.set(key(project, scope, path), { text: onDisk, baseline });
  return onDisk;
}

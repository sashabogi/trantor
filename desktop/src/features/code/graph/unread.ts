// The Unread lens (#7977, blueprint §4.3): code the crew wrote that no person has looked at.
// Flare's rule kept exactly: changedAt = newest of the watcher's file-changed stamp and the newest
// file.claim on the path; readAt = newest file.read; unread when changedAt > 0 && readAt < changedAt.

/** The two hub event types the lens reads, in the log's own shape. */
export type FileEvent = { type: string; ts: number; file?: string; project?: string };

/** One watcher stamp: the scope's tree changed at `path` at `ts`. */
export type ChangeStamp = { path: string; ts: number };

export type UnreadState = "unread" | "read" | "unchanged";

export const FILE_EVENT_TYPES = "file.claim,file.read";

/** Flare's rule; nothing is unread on a repo the operator merely opened (changedAt 0). */
export function unreadState(changedAt: number, readAt: number): UnreadState {
  if (changedAt <= 0) return "unchanged";
  return readAt < changedAt ? "unread" : "read";
}

type Stamps = { changedAt: number; readAt: number };

function fold(events: readonly FileEvent[], stamps: readonly ChangeStamp[]): Map<string, Stamps> {
  const byPath = new Map<string, Stamps>();
  const at = (path: string) => {
    const s = byPath.get(path);
    if (s) return s;
    const fresh = { changedAt: 0, readAt: 0 };
    byPath.set(path, fresh);
    return fresh;
  };
  for (const e of events) {
    if (!e.file) continue;
    if (e.type === "file.claim") { const s = at(e.file); s.changedAt = Math.max(s.changedAt, e.ts); }
    else if (e.type === "file.read") { const s = at(e.file); s.readAt = Math.max(s.readAt, e.ts); }
  }
  for (const c of stamps) { const s = at(c.path); s.changedAt = Math.max(s.changedAt, c.ts); }
  return byPath;
}

/** Per path, the lens's state, for one project's events plus the scope's watcher stamps. */
export function unreadMarks(events: readonly FileEvent[], stamps: readonly ChangeStamp[] = []): Map<string, UnreadState> {
  const out = new Map<string, UnreadState>();
  for (const [path, s] of fold(events, stamps)) out.set(path, unreadState(s.changedAt, s.readAt));
  return out;
}

export function unreadCount(marks: ReadonlyMap<string, UnreadState>): number {
  let n = 0;
  for (const state of marks.values()) if (state === "unread") n += 1;
  return n;
}

export type UnreadTally = { files: number; projects: number };

/** The Home stat: unread (project, file) pairs over every project's events, and how many projects. */
export function unreadTally(events: readonly FileEvent[]): UnreadTally {
  const byProject = new Map<string, FileEvent[]>();
  for (const e of events) {
    const project = e.project ?? "";
    const list = byProject.get(project);
    if (list) list.push(e);
    else byProject.set(project, [e]);
  }
  let files = 0;
  let projects = 0;
  for (const list of byProject.values()) {
    const n = unreadCount(unreadMarks(list));
    if (n === 0) continue;
    files += n;
    projects += 1;
  }
  return { files, projects };
}

export type UnreadStat = { value: string; sub: string };

/** The Home stat's two lines: "14 files" over "across 3 projects", or the calm zero. */
export function unreadStat(t: UnreadTally): UnreadStat {
  const value = `${t.files} file${t.files === 1 ? "" : "s"}`;
  if (t.files === 0) return { value, sub: "every crew change has been opened" };
  return { value, sub: `across ${t.projects} project${t.projects === 1 ? "" : "s"} · crew code no person has opened` };
}

// The Code lens's bridge to seats on ANOTHER machine (#13938): the Rust remote_seat commands
// run the git reads over ssh; these wrappers only parse what comes back. The states the drill
// demands are named here — "unreachable" is a transport failure string the Rust side prefixes,
// and nothing in this module ever turns a failure into an empty list.
import { invoke } from "@tauri-apps/api/core";

/** mirrors src-tauri/src/remote_seat.rs RemoteSeatSnapshot */
export type RemoteSeatSnapshot = {
  machine: string;
  branch: string;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  /** merge base with main/master on the remote machine, when one exists */
  base: string | null;
  status: { path: string; x: string; y: string }[];
  /** +N/−N vs HEAD — the uncommitted measure, same as the local panel's counts */
  counts: { path: string; plus: number | null; minus: number | null }[];
  /** +N/−N vs the merge base — committed AND uncommitted together */
  committed: { path: string; plus: number | null; minus: number | null }[];
  log: { sha: string; author: string; when: string; subject: string }[];
};

/** One changed path on a remote seat. Counts are vs BASE (what the seat did since branching);
 *  untracked paths carry null — git counted nothing, and a fake zero would read "known small". */
export type RemoteChangeRow = {
  path: string;
  status: string;
  plus: number | null;
  minus: number | null;
  untracked: boolean;
  /** the remote worktree has edits git status can see (vs HEAD) */
  uncommitted: boolean;
};

/** The changed files a remote seat contributes: committed-vs-base rows (counts included, the
 *  union truth) plus status-only rows (uncommitted edits, untracked). Row order: committed
 *  order first, then new status-only paths — first-seen, like mergeChanges locally. */
export function remoteChangeRows(snap: RemoteSeatSnapshot): RemoteChangeRow[] {
  const statusByPath = new Map(snap.status.map(e => [e.path, e]));
  const rows = new Map<string, RemoteChangeRow>();
  for (const c of snap.committed) {
    const st = statusByPath.get(c.path);
    rows.set(c.path, {
      path: c.path,
      status: st ? porcelainCode(st) : "M",
      plus: c.plus,
      minus: c.minus,
      untracked: false,
      uncommitted: !!st,
    });
  }
  const headCounts = new Map(snap.counts.map(c => [c.path, c]));
  for (const e of snap.status) {
    if (rows.has(e.path)) continue;
    const untracked = e.x === "?";
    const n = headCounts.get(e.path);
    rows.set(e.path, {
      path: e.path,
      status: porcelainCode(e),
      plus: untracked ? null : (n?.plus ?? null),
      minus: untracked ? null : (n?.minus ?? null),
      untracked,
      uncommitted: true,
    });
  }
  return [...rows.values()];
}

/** The one-letter code a row wears: untracked is "??", else worktree state over index state —
 *  the same "rawest status" idea mergeChanges keeps locally. */
function porcelainCode(e: { x: string; y: string }): string {
  if (e.x === "?") return "??";
  if (e.y !== " ") return e.y;
  return e.x;
}

/** A remote seat with nothing changed vs base AND nothing uncommitted — only this is "clean". */
export function isRemoteClean(snap: RemoteSeatSnapshot): boolean {
  return remoteChangeRows(snap).length === 0;
}

/** The Rust side prefixes transport failures with "unreachable: " — ssh down, no route, auth
 *  refused. This is the state that must NEVER render as clean. Feed it the boundary-parsed
 *  message (`e instanceof Error ? e.message : String(e)`), the shape Tauri rejects with. */
export function isUnreachable(err: string): boolean {
  return err.startsWith("unreachable:");
}

/** The first line of an already-parsed error message, for one-line states in pickers and panels. */
export function errorLine(err: string): string {
  return err.split("\n").find(l => l.trim() !== "") ?? err;
}

/** machines.<label>.ssh from config.json, or null when the label has no target. */
export async function machineSsh(machine: string): Promise<string | null> {
  const target = await invoke<string | null>("machine_ssh", { machine });
  return target && target.trim() ? target : null;
}

export async function remoteSeatSnapshot(project: string, agent: string, machine: string): Promise<RemoteSeatSnapshot> {
  return JSON.parse(await invoke<string>("remote_seat_snapshot", { project, agent, machine }));
}

export type RemotePatch = { patch: string; truncated: boolean };

export async function remoteFilePatch(project: string, agent: string, machine: string, path: string): Promise<RemotePatch> {
  return JSON.parse(await invoke<string>("remote_file_patch", { project, agent, machine, path }));
}

export type RemoteBody = { text: string; truncated: boolean; bytes: number };

export async function remoteFileBody(project: string, agent: string, machine: string, path: string): Promise<RemoteBody> {
  return JSON.parse(await invoke<string>("remote_file_body", { project, agent, machine, path }));
}

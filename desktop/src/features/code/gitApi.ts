// The Review lens's git panel bridge (#5775): one snapshot command, three mutations — all against
// the SELECTED SEAT's worktree, the tree review is already looking at. The Rust side owns path
// validation and every git subprocess; these wrappers only parse what comes back, and a malformed
// payload throws here so the panel renders its error state rather than half a snapshot.
import { invoke } from "@tauri-apps/api/core";

/** One raw `git status --porcelain=v1` row: X = index state, Y = worktree state, "?" = untracked. */
export type GitStatusEntry = { path: string; x: string; y: string };

export type GitLogEntry = { sha: string; author: string; when: string; subject: string };

/** +N/−N for one changed path vs HEAD. Untracked and binary paths are absent — git counts
 *  neither, and a fake zero would read as "known small". */
export type GitLineCount = { path: string; plus: number; minus: number };

/** One (seat, path) change row from `project_changes` (#5959). seat null = the project checkout. */
export type ProjectChangeRow = {
  seat: string | null;
  path: string;
  status: string;
  plus: number | null;
  minus: number | null;
};

/** The union entry the CHANGED list and the tree render from: one path, every seat that touched
 *  it, summed counts (null stays null — no count was ever measured), and the rawest status. */
export type MergedChange = {
  path: string;
  seats: (string | null)[];
  status: string;
  plus: number | null;
  minus: number | null;
};

export async function projectChanges(project: string): Promise<ProjectChangeRow[]> {
  return JSON.parse(await invoke<string>("project_changes", { project }));
}

/** Union the per-seat rows by path (#5959). Order: most recently… rows arrive per seat; the merge
 *  preserves first-seen path order and dedupes seats. Counts SUM across seats only when every
 *  contributor measured them — mixing a sum with a null would claim a measurement nobody made. */
export function mergeChanges(rows: ProjectChangeRow[]): MergedChange[] {
  const byPath = new Map<string, MergedChange>();
  for (const r of rows) {
    const hit = byPath.get(r.path);
    if (!hit) {
      byPath.set(r.path, {
        path: r.path,
        seats: [r.seat],
        status: r.status,
        plus: r.plus,
        minus: r.minus,
      });
      continue;
    }
    if (!hit.seats.includes(r.seat)) hit.seats.push(r.seat);
    if (hit.plus !== null && r.plus !== null) hit.plus += r.plus;
    else hit.plus = null;
    if (hit.minus !== null && r.minus !== null) hit.minus += r.minus;
    else hit.minus = null;
    if (r.status !== " ") hit.status = hit.status === r.status ? hit.status : hit.status;
  }
  return [...byPath.values()];
}

/** Folder roll-up (#5959): every ancestor directory of a changed path inherits the seats that
 *  touched anything under it — the tree's folders wear the marks of their subtree. */
export function folderSeats(
  entries: MergedChange[],
): Record<string, (string | null)[]> {
  const out: Record<string, (string | null)[]> = {};
  for (const e of entries) {
    const parts = e.path.split("/");
    parts.pop(); // the file row shows its own marks; folders are the ancestors
    let dir = "";
    for (const part of parts) {
      dir = dir ? `${dir}/${part}` : part;
      const seats = (out[dir] ??= []);
      for (const s of e.seats) if (!seats.includes(s)) seats.push(s);
    }
  }
  return out;
}

/** The +N/−N chip values for a path across ALL seats. Same null rule as lineCountFor. */
export function mergedCountFor(
  entries: MergedChange[],
  path: string,
): { plus: number; minus: number } | null {
  const hit = entries.find(e => e.path === path);
  if (!hit || hit.plus === null || hit.minus === null) return null;
  return { plus: hit.plus, minus: hit.minus };
}

export type GitPanelSnapshot = {
  branch: string;
  upstream: string | null;
  /** commits ahead of the upstream — or of the merge base with main when no upstream is set */
  ahead: number | null;
  /** only measured against an upstream; null without one */
  behind: number | null;
  status: GitStatusEntry[];
  counts: GitLineCount[];
  log: GitLogEntry[];
};

export async function gitPanel(project: string, agent: string): Promise<GitPanelSnapshot> {
  return JSON.parse(await invoke<string>("git_panel", { project, agent }));
}

export async function gitStage(
  project: string,
  agent: string,
  paths: string[],
  unstage = false,
): Promise<void> {
  await invoke("git_stage", { project, agent, paths, unstage });
}

export async function gitCommit(project: string, agent: string, message: string): Promise<string> {
  return invoke<string>("git_commit", { project, agent, message });
}

export async function gitPush(project: string, agent: string): Promise<string> {
  return invoke<string>("git_push", { project, agent });
}

/** porcelain v1 XY: X is the index state, Y the worktree state. "??" is untracked; X !== " "
 * means something is staged; Y !== " " means the worktree differs from the index. A path can be
 * in BOTH lists (staged, then edited again) — the panel shows it in each rather than picking one,
 * because collapsing the two is how a staged change gets committed stale. */
export type StatusBuckets = {
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
  untracked: string[];
};
export function bucketStatus(entries: GitStatusEntry[]): StatusBuckets {
  const staged: GitStatusEntry[] = [];
  const unstaged: GitStatusEntry[] = [];
  const untracked: string[] = [];
  for (const e of entries) {
    if (e.x === "?") {
      untracked.push(e.path);
      continue;
    }
    if (e.x !== " ") staged.push(e);
    if (e.y !== " ") unstaged.push(e);
  }
  return { staged, unstaged, untracked };
}

/** One honest line about where this branch stands. With an upstream both arrows mean something;
 * without one, "ahead" counts the seat's unlanded work against main and behind is not claimed. */
export function aheadLabel(s: Pick<GitPanelSnapshot, "ahead" | "behind" | "upstream">): string {
  if (s.upstream) {
    const parts: string[] = [];
    if (s.ahead) parts.push(`↑${s.ahead}`);
    if (s.behind) parts.push(`↓${s.behind}`);
    return parts.length > 0 ? parts.join(" ") : "in sync";
  }
  if (s.ahead) return `${s.ahead} unlanded`;
  return "all landed";
}

/** The two sections the SCM panel renders, as the exact pathspecs each bulk action sends in ONE
 *  batched git call (RESEARCH-orca-files §3: batch against E2BIG, never one subprocess per file).
 *  `staged` is what "unstage all" restores; `changes` merges the unstaged and untracked rows, which
 *  the panel shows as a single section. A path edited after staging appears in BOTH, on purpose —
 *  the two actions mean different things to it. */
export type ScmSections = { staged: string[]; changes: string[] };
export function scmSections(entries: GitStatusEntry[]): ScmSections {
  const { staged, unstaged, untracked } = bucketStatus(entries);
  return {
    staged: staged.map(e => e.path),
    changes: [...unstaged.map(e => e.path), ...untracked],
  };
}

/** The porcelain XY pairs git uses for unmerged (conflicted) paths — both sides moved and git
 *  needs a human. Receipt: `git status --porcelain=v1` short-format table, the "Unmerged" block. */
const UNMERGED_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export function isUnmerged(entry: Pick<GitStatusEntry, "x" | "y">): boolean {
  return UNMERGED_CODES.has(`${entry.x}${entry.y}`);
}

/** The conflicted paths, for the SCM panel to protect: staging one erases git's conflict record
 *  (the only live signal that a review is still owed), so bulk stage skips them and the row's
 *  stage button refuses with that reason. Orca reaches the same rule from richer data
 *  (uncommitted-entry-row.tsx:82-83); ours reads it straight off the porcelain code. */
export function conflictPaths(entries: GitStatusEntry[]): string[] {
  return entries.filter(isUnmerged).map(e => e.path);
}

/** Bulk-stage pathspecs minus the conflicted rows. The row-level refusal and this list share one
 *  predicate, so the button and the batch can never disagree about what is protected. */
export function stageableChanges(entries: GitStatusEntry[]): string[] {
  const blocked = new Set(conflictPaths(entries));
  return scmSections(entries).changes.filter(p => !blocked.has(p));
}

/** The +N/−N chip values for one path. null when git counted nothing (untracked, binary, or
 *  unchanged) — the chip then renders nothing rather than a zero. */
export function lineCountFor(
  counts: GitLineCount[],
  path: string,
): { plus: number; minus: number } | null {
  const hit = counts.find(c => c.path === path);
  return hit ? { plus: hit.plus, minus: hit.minus } : null;
}

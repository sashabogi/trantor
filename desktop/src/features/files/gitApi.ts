// The Review lens's git panel bridge (#5775): one snapshot command, three mutations — all against
// the SELECTED SEAT's worktree, the tree review is already looking at. The Rust side owns path
// validation and every git subprocess; these wrappers only parse what comes back, and a malformed
// payload throws here so the panel renders its error state rather than half a snapshot.
import { invoke } from "@tauri-apps/api/core";

/** One raw `git status --porcelain=v1` row: X = index state, Y = worktree state, "?" = untracked. */
export type GitStatusEntry = { path: string; x: string; y: string };

export type GitLogEntry = { sha: string; author: string; when: string; subject: string };

export type GitPanelSnapshot = {
  branch: string;
  upstream: string | null;
  /** commits ahead of the upstream — or of the merge base with main when no upstream is set */
  ahead: number | null;
  /** only measured against an upstream; null without one */
  behind: number | null;
  status: GitStatusEntry[];
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

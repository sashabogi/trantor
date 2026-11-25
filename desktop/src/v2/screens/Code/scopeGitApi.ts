// The Code screen's git bridge for either checkout (#13988 drill): a seat's worktree by agent, or the
// project's main checkout (agent null → scope "project"). Developer mode alone enables push/discard there.
// #14268: every call goes through the logged invoke so the Output tab can list the git commands this screen ran.
import { loggedInvoke as invoke } from "../../ui/BottomPanel/gitLog";
import type { GitPanelSnapshot } from "../../../features/code/gitApi";
import { MODE_CONFIG, readMode, type Mode } from "../../shell/shellMode";

/** null is the project's main checkout. */
export type GitScopeArg = string | null;

export function scopeArgs(agent: GitScopeArg): { agent: string } | { scope: "project" } {
  return agent ? { agent } : { scope: "project" };
}

type PanelArgs = { project: string; agent?: string; scope?: "project"; limit?: number };

/** `limit` is the log length; Rust defaults to the seat panel's 15 and caps it at 200. */
export async function scopePanel(project: string, agent: GitScopeArg, limit?: number): Promise<GitPanelSnapshot> {
  const args: PanelArgs = { project, ...scopeArgs(agent) };
  if (limit !== undefined) args.limit = limit;
  return JSON.parse(await invoke<string>("git_panel", args));
}

export async function scopeStage(project: string, agent: GitScopeArg, paths: string[], unstage: boolean): Promise<void> {
  await invoke("git_stage", { project, ...scopeArgs(agent), paths, unstage });
}

export async function scopeCommit(project: string, agent: GitScopeArg, message: string): Promise<string> {
  return invoke<string>("git_commit", { project, ...scopeArgs(agent), message });
}

export async function scopeAmend(project: string, agent: GitScopeArg, message: string): Promise<string> {
  return invoke<string>("git_commit_amend", { project, ...scopeArgs(agent), message });
}

export async function scopeUndo(project: string, agent: GitScopeArg): Promise<string> {
  return invoke<string>("git_commit_undo", { project, ...scopeArgs(agent) });
}

export type GitPatchAction = "stage" | "unstage" | "discard";

export async function scopeApplyPatch(project: string, agent: GitScopeArg, path: string, patch: string, action: GitPatchAction): Promise<string> {
  if (action === "discard") {
    const refusal = checkoutMutationRefusal(agent);
    if (refusal) throw new Error(refusal);
  }
  return invoke<string>("git_apply_patch", { project, ...scopeArgs(agent), path, patch, action });
}

// #14268: sync failures show one useful line without git's command or severity prefixes.
export function syncError(raw: string): string {
  const line = raw.split(/\r?\n/).map(part => part.trim()).find(Boolean) ?? "";
  return line.replace(/^git\s+.+?\s+failed:\s*/i, "").replace(/^(?:(?:fatal|error):\s*)+/i, "").trim() || "Git sync failed";
}

async function syncInvoke<T>(command: "git_fetch" | "git_pull" | "git_push", args: PanelArgs & { strategy?: GitPullStrategy }): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new Error(syncError(error instanceof Error ? error.message : String(error ?? "")));
  }
}

export async function scopeFetch(project: string, agent: GitScopeArg): Promise<void> {
  await syncInvoke("git_fetch", { project, ...scopeArgs(agent) });
}

/** One file a commit touched: git's name-status letter, numstat counts (null when binary). */
export type GitShowFile = { path: string; status: string; plus: number | null; minus: number | null };
export type GitCommitShow = { sha: string; files: GitShowFile[]; patch: string; truncated: boolean };

export async function scopeShow(project: string, agent: GitScopeArg, sha: string): Promise<GitCommitShow> {
  return JSON.parse(await invoke<string>("git_show", { project, ...scopeArgs(agent), sha }));
}

export type GitHistoryEntry = { sha: string; author: string; when: string; subject: string; refs: string[] };
export type GitHistoryFilter = { all: boolean; file?: string; message?: string; limit?: number };

export async function scopeHistory(project: string, agent: GitScopeArg, filter: GitHistoryFilter): Promise<GitHistoryEntry[]> {
  return JSON.parse(await invoke<string>("git_history", {
    project, ...scopeArgs(agent), all: filter.all, file: filter.file ?? null, message: filter.message ?? null, limit: filter.limit ?? null,
  }));
}

export type GitCommitMeta = { sha: string; author: string; when: string; subject: string; message: string; parents: string[]; github_url: string | null };

export async function scopeCommitMeta(project: string, agent: GitScopeArg, sha: string): Promise<GitCommitMeta> {
  return JSON.parse(await invoke<string>("git_commit_meta", { project, ...scopeArgs(agent), sha }));
}

export type GitBlameLine = { line: number; sha: string; author: string; when: string; subject: string };

export async function scopeBlame(project: string, agent: GitScopeArg, path: string): Promise<GitBlameLine[]> {
  return JSON.parse(await invoke<string>("git_blame", { project, ...scopeArgs(agent), path }));
}

export type GitOperation = { operation: "merge" | "rebase" | "cherry-pick" | "revert" | null; conflicts: number };

export async function scopeOperation(project: string, agent: GitScopeArg): Promise<GitOperation> {
  return JSON.parse(await invoke<string>("git_operation", { project, ...scopeArgs(agent) }));
}

export async function scopeOperationContinue(project: string, agent: GitScopeArg): Promise<void> {
  await invoke("git_operation_continue", { project, ...scopeArgs(agent) });
}

export async function scopeOperationAbort(project: string, agent: GitScopeArg): Promise<void> {
  await invoke("git_operation_abort", { project, ...scopeArgs(agent) });
}

export type GitBranch = {
  name: string; sha: string; committed_at: number; ahead: number | null; behind: number | null;
  current: boolean; remote: boolean; worktree: string | null;
};
export type GitBranchList = { current: string | null; branches: GitBranch[] };
export type GitBranchResult = { status: "done" | "conflict" | "dirty"; reason: string; conflicts: string[] };
export type GitBranchDeleteResult = { status: "deleted" | "confirm"; unique: number };
export type GitDirtySwitch = "ask" | "bring" | "stash";

export async function scopeBranches(project: string, agent: GitScopeArg): Promise<GitBranchList> {
  return JSON.parse(await invoke<string>("git_branch_list", { project, ...scopeArgs(agent) }));
}

export async function scopeBranchCreate(project: string, agent: GitScopeArg, name: string, sha?: string): Promise<void> {
  await invoke("git_branch_create", { project, ...scopeArgs(agent), name, sha: sha ?? null });
}

export async function scopeBranchSwitch(project: string, agent: GitScopeArg, name: string, dirty: GitDirtySwitch): Promise<GitBranchResult> {
  return JSON.parse(await invoke<string>("git_branch_switch", { project, ...scopeArgs(agent), name, dirty }));
}

export async function scopeBranchRename(project: string, agent: GitScopeArg, old: string, next: string): Promise<void> {
  await invoke("git_branch_rename", { project, ...scopeArgs(agent), old, new: next });
}

export async function scopeBranchDelete(project: string, agent: GitScopeArg, name: string, force = false): Promise<GitBranchDeleteResult> {
  return JSON.parse(await invoke<string>("git_branch_delete", { project, ...scopeArgs(agent), name, force }));
}

async function integrate(project: string, agent: GitScopeArg, name: string, operation: "merge" | "rebase"): Promise<GitBranchResult> {
  return JSON.parse(await invoke<string>(`git_branch_${operation}`, { project, ...scopeArgs(agent), name }));
}

export function scopeBranchMerge(project: string, agent: GitScopeArg, name: string): Promise<GitBranchResult> {
  return integrate(project, agent, name, "merge");
}

export function scopeBranchRebase(project: string, agent: GitScopeArg, name: string): Promise<GitBranchResult> {
  return integrate(project, agent, name, "rebase");
}

export type GitPullStrategy = "ff" | "merge" | "rebase";
export type GitPullResult = { status: "pulled" | "upToDate" | "diverged"; reason: string };

export async function scopePull(project: string, agent: GitScopeArg, strategy: GitPullStrategy = "ff"): Promise<GitPullResult> {
  return JSON.parse(await syncInvoke<string>("git_pull", { project, ...scopeArgs(agent), strategy }));
}

export type GitStash = { name: string; sha: string; created_at: number; message: string };
export type GitStashAction = "apply" | "pop" | "drop";

export async function scopeStashes(project: string, agent: GitScopeArg): Promise<GitStash[]> {
  const rows: unknown = JSON.parse(await invoke<string>("git_stash_list", { project, ...scopeArgs(agent) }));
  if (!Array.isArray(rows)) throw new Error("git_stash_list returned a malformed payload");
  return rows;
}

export async function scopeStashSave(project: string, agent: GitScopeArg, message: string): Promise<void> {
  await invoke("git_stash_save", { project, ...scopeArgs(agent), message });
}

export async function scopeStashChange(project: string, agent: GitScopeArg, reference: string, action: GitStashAction): Promise<void> {
  await invoke("git_stash_change", { project, ...scopeArgs(agent), reference, action });
}

/** The one reason the main checkout gives when the mode does not offer a mutation. */
export const CHECKOUT_REFUSAL = "On the main checkout, pushing and discarding go through the orchestrator";

export const HISTORY_REFUSAL = "On the main checkout, changing a commit goes through the orchestrator. Developer mode allows it.";

/** Amend and undo rewrite a commit, so they follow the same mode rule as push and discard. */
export function historyMutationRefusal(agent: GitScopeArg, mode: Mode = readMode()): string | null {
  return agent || MODE_CONFIG[mode].ownCheckoutMutations ? null : HISTORY_REFUSAL;
}

export const BRANCH_REFUSAL = "On the main checkout, branch changes go through the orchestrator. Developer mode allows them.";

/** Creating, switching, renaming, deleting, merging and rebasing follow the same mode rule as push and discard. */
export function branchMutationRefusal(agent: GitScopeArg, mode: Mode = readMode()): string | null {
  return agent || MODE_CONFIG[mode].ownCheckoutMutations ? null : BRANCH_REFUSAL;
}

export function checkoutMutationRefusal(agent: GitScopeArg, mode: Mode = readMode()): string | null {
  return agent || MODE_CONFIG[mode].ownCheckoutMutations ? null : CHECKOUT_REFUSAL;
}

export async function scopePush(project: string, agent: GitScopeArg): Promise<string> {
  const refusal = checkoutMutationRefusal(agent);
  if (refusal) throw new Error(refusal);
  return syncInvoke<string>("git_push", { project, ...scopeArgs(agent) });
}

/** Omit paths to discard every change. Rust copies every existing path to the Trash first. */
export async function scopeDiscard(project: string, agent: GitScopeArg, paths?: string[]): Promise<string> {
  const refusal = checkoutMutationRefusal(agent);
  if (refusal) throw new Error(refusal);
  const args: PanelArgs & { paths?: string[] } = { project, ...scopeArgs(agent) };
  if (paths) args.paths = paths;
  return invoke<string>("git_discard", args);
}

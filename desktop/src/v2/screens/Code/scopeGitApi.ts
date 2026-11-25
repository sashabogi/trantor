// The Code screen's git bridge for either checkout (#13988 drill): a seat's worktree by agent, or the
// project's main checkout (agent null → scope "project"). Developer mode alone enables push/discard there.
import { invoke } from "@tauri-apps/api/core";
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

export async function scopeFetch(project: string, agent: GitScopeArg): Promise<void> {
  await invoke("git_fetch", { project, ...scopeArgs(agent) });
}

/** One file a commit touched: git's name-status letter, numstat counts (null when binary). */
export type GitShowFile = { path: string; status: string; plus: number | null; minus: number | null };
export type GitCommitShow = { sha: string; files: GitShowFile[]; patch: string; truncated: boolean };

export async function scopeShow(project: string, agent: GitScopeArg, sha: string): Promise<GitCommitShow> {
  return JSON.parse(await invoke<string>("git_show", { project, ...scopeArgs(agent), sha }));
}

export type GitPullStrategy = "ff" | "merge" | "rebase";
export type GitPullResult = { status: "pulled" | "upToDate" | "diverged"; reason: string };

export async function scopePull(project: string, agent: GitScopeArg, strategy: GitPullStrategy = "ff"): Promise<GitPullResult> {
  return JSON.parse(await invoke<string>("git_pull", { project, ...scopeArgs(agent), strategy }));
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

export function checkoutMutationRefusal(agent: GitScopeArg, mode: Mode = readMode()): string | null {
  return agent || MODE_CONFIG[mode].ownCheckoutMutations ? null : CHECKOUT_REFUSAL;
}

export async function scopePush(project: string, agent: GitScopeArg): Promise<string> {
  const refusal = checkoutMutationRefusal(agent);
  if (refusal) throw new Error(refusal);
  return invoke<string>("git_push", { project, ...scopeArgs(agent) });
}

/** Omit paths to discard every change. Rust copies every existing path to the Trash first. */
export async function scopeDiscard(project: string, agent: GitScopeArg, paths?: string[]): Promise<string> {
  const refusal = checkoutMutationRefusal(agent);
  if (refusal) throw new Error(refusal);
  const args: PanelArgs & { paths?: string[] } = { project, ...scopeArgs(agent) };
  if (paths) args.paths = paths;
  return invoke<string>("git_discard", args);
}

// The Code screen's git bridge for either checkout (#13988 drill): a seat's worktree by agent, or the
// project's main checkout (agent null → scope "project"). Push stays seat-only in Rust and here.
import { invoke } from "@tauri-apps/api/core";
import type { GitPanelSnapshot } from "../../../features/code/gitApi";

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

/** The one reason the main checkout gives for every action it does not offer. */
export const CHECKOUT_REFUSAL = "On the main checkout, pushing and discarding go through the orchestrator";

// #14300: the repo's active agent and helper worktrees, polled with the scope's 6 s cadence, so source
// control shows work that lives outside the main checkout until the orchestrator lands it.
import { useEffect, useState } from "react";
import { loggedInvoke as invoke } from "../../ui/BottomPanel/gitLog";
import { WORKTREE_SCOPE_PREFIX } from "./scopeGitApi";

export type AgentWorktree = {
  path: string;
  branch: string | null;
  head: string;
  locked: boolean;
  kind: "agent" | "helper" | "seat" | "other";
  /** unix seconds */
  last_activity: number;
  changed: number;
  ahead: number;
};

const POLL_MS = 6_000;
const LIVE_MS = 60_000;

/** The scope string a worktree row picks; the Rust side only resolves paths `git worktree list` reports. */
export const worktreeScope = (w: Pick<AgentWorktree, "path">): string => `${WORKTREE_SCOPE_PREFIX}${w.path}`;

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** "agent a1b2c3d" for a sub-agent, "helper codex" for a one-shot helper, else the branch. */
export function worktreeLabel(w: Pick<AgentWorktree, "path" | "branch" | "kind">): string {
  const name = base(w.path);
  if (w.kind === "agent") return `agent ${name.replace(/^agent-/, "").slice(0, 7)}`;
  if (w.kind === "helper") return `helper ${name.replace(/^wt-/, "")}`;
  return w.branch ?? name;
}

/** The label for a `wt:` scope, from the list when it is still there, else the folder name. */
export function scopeWorktreeLabel(scope: string, list: AgentWorktree[]): string {
  const path = scope.slice(WORKTREE_SCOPE_PREFIX.length);
  const hit = list.find(w => w.path === path);
  return hit ? worktreeLabel(hit) : base(path);
}

/** A pulsing dot means it is running now: locked, or touched in the last minute. */
export const worktreeLive = (w: AgentWorktree, now = Date.now()): boolean => w.locked || now - w.last_activity * 1000 < LIVE_MS;

export const worktreeCounts = (w: AgentWorktree): string =>
  `${w.changed} ${w.changed === 1 ? "file" : "files"} changed · ${w.ahead} ${w.ahead === 1 ? "commit" : "commits"}`;

/** Agent and helper worktrees only; seats already have their own rows. */
export function useAgentWorktrees(project: string): AgentWorktree[] {
  const [rows, setRows] = useState<AgentWorktree[]>([]);
  useEffect(() => {
    let alive = true;
    const read = () => {
      invoke<string>("git_worktrees", { project })
        .then(raw => {
          // SAFETY: git_worktrees answers a JSON array of AgentWorktree rows; anything else is dropped below.
          const parsed = JSON.parse(raw) as AgentWorktree[] | null;
          if (alive) setRows(Array.isArray(parsed) ? parsed.filter(w => w.kind === "agent" || w.kind === "helper") : []);
        })
        .catch(() => { if (alive) setRows([]); });
    };
    read();
    const iv = setInterval(read, POLL_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [project]);
  return rows;
}

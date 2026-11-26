// One scope's git state for the Code screen (#13988): a seat's worktree or the project's main
// checkout, both through git_panel (the checkout by scope "project", #13988 drill).
// #14344: the read itself lives in scopeGitStore, shared by everything that watches this scope.
import { useCallback, useEffect, useRef, useState } from "react";
import type { GitLineCount, GitLogEntry, GitStatusEntry } from "../../../features/code/gitApi";
import { subscribeScopeGit, type ScopeGitSubscription } from "./scopeGitStore";

export type ScopeSnapshot = {
  /** null is the project checkout. */
  scope: string | null;
  /** null only on a detached HEAD. */
  branch: string | null;
  upstream: string | null;
  remote: string | null;
  ahead: number | null;
  behind: number | null;
  status: GitStatusEntry[];
  counts: GitLineCount[];
  log: GitLogEntry[];
  /** a seat's worktree; false is the main checkout, whose push/discard policy comes from the shell mode. */
  seatBacked: boolean;
  readAt: number;
};

export type ScopeState =
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "ok"; snap: ScopeSnapshot };

export type ScopeGit = { state: ScopeState; refresh: () => void };

export function useScopeGit(project: string, scope: string | null): ScopeGit {
  const [state, setState] = useState<ScopeState>({ kind: "loading" });
  const sub = useRef<ScopeGitSubscription | null>(null);
  const refresh = useCallback(() => sub.current?.refresh(), []);
  useEffect(() => {
    setState({ kind: "loading" });
    const joined = subscribeScopeGit(project, scope, setState);
    sub.current = joined;
    return () => { joined.unsubscribe(); if (sub.current === joined) sub.current = null; };
  }, [project, scope]);
  return { state, refresh };
}

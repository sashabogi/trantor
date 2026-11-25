// One scope's git state for the Code screen (#13988): a seat's worktree or the project's main
// checkout, both through git_panel (the checkout by scope "project", #13988 drill).
import { useCallback, useEffect, useRef, useState } from "react";
import type { GitLineCount, GitLogEntry, GitStatusEntry } from "../../../features/code/gitApi";
import { scopePanel } from "./scopeGitApi";

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

const POLL_MS = 6_000;

async function read(project: string, scope: string | null): Promise<ScopeSnapshot> {
  const p = await scopePanel(project, scope);
  return { scope, branch: p.branch || null, upstream: p.upstream, remote: p.remote, ahead: p.ahead, behind: p.behind,
    status: p.status, counts: p.counts, log: p.log, seatBacked: scope !== null, readAt: Date.now() };
}

export type ScopeGit = { state: ScopeState; refresh: () => void };

export function useScopeGit(project: string, scope: string | null): ScopeGit {
  const [state, setState] = useState<ScopeState>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  const latest = useRef(0);
  const refresh = useCallback(() => setTick(t => t + 1), []);
  useEffect(() => {
    const mine = ++latest.current;
    read(project, scope)
      .then(snap => { if (mine === latest.current) setState({ kind: "ok", snap }); })
      .catch(e => { if (mine === latest.current) setState({ kind: "error", reason: e instanceof Error ? e.message : String(e) }); });
  }, [project, scope, tick]);
  useEffect(() => {
    setState({ kind: "loading" });
    const iv = setInterval(refresh, POLL_MS);
    return () => clearInterval(iv);
  }, [project, scope, refresh]);
  return { state, refresh };
}

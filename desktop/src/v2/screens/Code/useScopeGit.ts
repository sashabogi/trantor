// One scope's git state for the Code screen (#13988): a seat's worktree through the classic git_panel
// command, or the project checkout through project_changes, the only checkout read that exists.
import { useCallback, useEffect, useRef, useState } from "react";
import { gitPanel, projectChanges, type GitLineCount, type GitLogEntry, type GitStatusEntry } from "../../../features/code/gitApi";

export type ScopeSnapshot = {
  /** null is the project checkout. */
  scope: string | null;
  /** null for the checkout: no command reads its branch name. */
  branch: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  status: GitStatusEntry[];
  counts: GitLineCount[];
  log: GitLogEntry[];
  /** git_panel only exists for seat worktrees, so only a seat has history and staging. */
  seatBacked: boolean;
  readAt: number;
};

export type ScopeState =
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "ok"; snap: ScopeSnapshot };

const POLL_MS = 6_000;

/** project_changes trims porcelain to one code, so staged and unstaged cannot be told apart there. */
export function checkoutStatus(code: string, path: string): GitStatusEntry {
  if (code === "??") return { path, x: "?", y: "?" };
  if (code.length >= 2) return { path, x: code[0], y: code[1] };
  return { path, x: " ", y: code || "M" };
}

async function read(project: string, scope: string | null): Promise<ScopeSnapshot> {
  if (scope) {
    const p = await gitPanel(project, scope);
    return { scope, branch: p.branch || null, upstream: p.upstream, ahead: p.ahead, behind: p.behind,
      status: p.status, counts: p.counts, log: p.log, seatBacked: true, readAt: Date.now() };
  }
  const rows = (await projectChanges(project)).filter(r => r.seat === null);
  return { scope: null, branch: null, upstream: null, ahead: null, behind: null,
    status: rows.map(r => checkoutStatus(r.status, r.path)),
    counts: rows.map(r => ({ path: r.path, plus: r.plus, minus: r.minus })),
    log: [], seatBacked: false, readAt: Date.now() };
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

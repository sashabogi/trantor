// What the seat bar and the hover card read about one crew seat: its worktree branch and its change count (#14351).
import { useEffect, useState } from "react";
import { gitPanel } from "../../../features/code/gitApi";
import { seatDiff } from "../../../features/code/seatDiff";
import type { SeatView } from "./seatModel";

export type Branch = { name: string; ahead: number | null } | null;
export type ChangeCount = { plus: number; minus: number; files: number } | null;

/** The agent whose worktree this seat owns on this machine; null for the orchestrator, helpers, sub-agents and remote seats. */
export const worktreeAgent = (seat: SeatView): string | null =>
  seat.isOrchestrator || seat.isHelper || seat.agentInfo || seat.machine ? null : seat.agent;

/** The seat's own worktree branch and how far ahead it is, from the classic git bridge; null when unreadable. */
export function useBranch(project: string, seat: SeatView): Branch {
  const [branch, setBranch] = useState<Branch>(null);
  const agent = seat.isOrchestrator ? null : seat.agent;
  useEffect(() => {
    let alive = true;
    setBranch(null);
    if (!agent || seat.machine) return;
    gitPanel(project, agent).then(s => { if (alive) setBranch({ name: s.branch, ahead: s.ahead }); }).catch(() => {});
    return () => { alive = false; };
  }, [project, agent, seat.machine]);
  return branch;
}

/** Lines added and removed and files touched in the seat's worktree, read once; null until known. */
export function useChangeCount(project: string, seat: SeatView): ChangeCount {
  const [count, setCount] = useState<ChangeCount>(null);
  const agent = worktreeAgent(seat);
  useEffect(() => {
    let alive = true;
    setCount(null);
    if (!agent) return;
    seatDiff(project, agent).then(d => {
      if (alive) setCount({ plus: d.files.reduce((n, f) => n + (f.plus ?? 0), 0), minus: d.files.reduce((n, f) => n + (f.minus ?? 0), 0), files: d.files.length });
    }).catch(() => {});
    return () => { alive = false; };
  }, [project, agent]);
  return count;
}

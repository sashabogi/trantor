import { useEffect, useMemo, useState } from "react";
import { useShellMode } from "../../shell/shellMode";
import { seatLabel } from "../../ui/identity";
import { groupBranches, type SeatInfo } from "./model";
import {
  branchMutationRefusal, scopeBranchDelete, scopeBranchMerge, scopeBranchRebase, scopeBranchRename, scopeBranchSwitch, scopeBranches,
  type GitBranch, type GitBranchResult, type GitDirtySwitch, type GitScopeArg,
} from "./scopeGitApi";
import type { ScopeSnapshot } from "./useScopeGit";

export type ErrorHandler = (message: string) => void;
export const errorMessage = (error: Error | string) => error instanceof Error ? error.message : String(error);

export type BranchOps = {
  branch: (name: string) => GitBranch | undefined;
  switchTo: (branch: GitBranch) => void;
  rename: (branch: GitBranch) => void;
  remove: (branch: GitBranch) => void;
  integrate: (operation: "merge" | "rebase", branch: GitBranch) => void;
  mutationReason: () => string | null;
  switchReason: (branch: GitBranch) => string | null;
  renameReason: (branch: GitBranch) => string | null;
  deleteReason: (branch: GitBranch) => string | null;
};

export type BranchDialogState =
  | { kind: "create" }
  | { kind: "switch"; branch: GitBranch }
  | { kind: "rename"; branch: GitBranch }
  | { kind: "delete"; branch: GitBranch; unique: number }
  | null;

type BranchOpsArgs = {
  project: string;
  seats: SeatInfo[];
  snap: ScopeSnapshot | null;
  scope: GitScopeArg;
  onClose: () => void;
  onMutated: () => void;
  onError: ErrorHandler;
  onOpenConflict: (path: string | null) => void;
};

export function useBranchOps({ project, seats, snap, scope, onClose, onMutated, onError, onOpenConflict }: BranchOpsArgs) {
  const mode = useShellMode();
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<BranchDialogState>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void scopeBranches(project, scope).then(result => { if (alive) { setBranches(result.branches); setReadError(null); } })
      .catch(error => { if (alive) setReadError(errorMessage(error)); });
    return () => { alive = false; };
  }, [project, scope, revision]);
  const branch = (name: string) => branches.find(item => item.name === name && !item.remote);
  const seat = (name: string) => seats.find(item => item.branch === name);
  const mutationReason = () => {
    const refusal = branchMutationRefusal(scope, mode);
    if (refusal) return refusal;
    const current = seats.find(item => item.seat === scope);
    return current?.presence === "working" ? `${seatLabel(current.seat)} is working; change its worktree after the turn ends` : !snap ? "Reading git" : busy ? "Branch operation in progress" : null;
  };
  const switchReason = (item: GitBranch) => mutationReason() ?? (item.current ? "Already the current branch" : item.worktree ? `Checked out in ${seat(item.name)?.seat ?? "another worktree"}; open that row instead` : null);
  const renameReason = (item: GitBranch) => {
    const owner = seat(item.name);
    return owner && owner.seat !== scope ? `Open ${seatLabel(owner.seat)}'s worktree to rename its branch` : mutationReason();
  };
  const deleteReason = (item: GitBranch) => item.name === "main" ? "main is protected and cannot be deleted"
    : item.current ? "The checked-out branch cannot be deleted; switch first"
      : item.worktree ? `Checked out in ${seat(item.name)?.seat ?? "another worktree"}` : mutationReason();
  const finish = () => { setRevision(value => value + 1); onMutated(); onClose(); };
  const result = (value: GitBranchResult) => {
    if (value.status === "conflict") { onMutated(); onClose(); onOpenConflict(value.conflicts[0] ?? null); }
    else finish();
  };
  const switchTo = (item: GitBranch, dirty: GitDirtySwitch = "ask") => {
    if (!snap) return;
    if (snap.status.length > 0 && dirty === "ask") { setDialog({ kind: "switch", branch: item }); return; }
    setBusy(true);
    void scopeBranchSwitch(project, scope, item.name, dirty).then(value => {
      if (value.status === "dirty") setDialog({ kind: "switch", branch: item });
      else { setDialog(null); result(value); }
    }).catch(error => onError(errorMessage(error))).finally(() => setBusy(false));
  };
  const integrate = (operation: "merge" | "rebase", item: GitBranch) => {
    setBusy(true);
    const command = operation === "merge" ? scopeBranchMerge : scopeBranchRebase;
    void command(project, scope, item.name).then(result).catch(error => onError(errorMessage(error))).finally(() => setBusy(false));
  };
  const remove = (item: GitBranch, force = false) => {
    setBusy(true);
    void scopeBranchDelete(project, scope, item.name, force).then(value => {
      if (value.status === "confirm") setDialog({ kind: "delete", branch: item, unique: value.unique });
      else { setDialog(null); finish(); }
    }).catch(error => onError(errorMessage(error))).finally(() => setBusy(false));
  };
  const rename = (old: string, next: string) => {
    setBusy(true);
    void scopeBranchRename(project, scope, old, next).then(() => { setDialog(null); finish(); })
      .catch(error => onError(errorMessage(error))).finally(() => setBusy(false));
  };
  const ops: BranchOps = { branch, switchTo, rename: item => setDialog({ kind: "rename", branch: item }), remove, integrate, mutationReason, switchReason, renameReason, deleteReason };
  return { branches, readError, dialog, setDialog, busy, ops, switchTo, remove, rename, finish };
}

export function useBranchRows(seats: SeatInfo[], branches: GitBranch[]) {
  const [filter, setFilter] = useState("");
  const [show, setShow] = useState<"all" | "seats">("all");
  const [sort, setSort] = useState<"recent" | "name">("recent");
  const groups = useMemo(() => groupBranches({ seats, filter, show, sort }), [seats, filter, show, sort]);
  const locals = useMemo(() => {
    const seatNames = new Set(groups.seats.map(seat => seat.branchLabel));
    const query = filter.trim().toLowerCase();
    const rows = branches.filter(branch => !branch.remote && !seatNames.has(branch.name) && (!query || branch.name.toLowerCase().includes(query)));
    if (sort === "name") rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }, [branches, filter, groups.seats, sort]);
  const remotes = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const rows = branches.filter(branch => branch.remote && (!query || branch.name.toLowerCase().includes(query)));
    if (sort === "name") rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }, [branches, filter, sort]);
  return { filter, setFilter, show, setShow, sort, setSort, groups, locals, remotes };
}

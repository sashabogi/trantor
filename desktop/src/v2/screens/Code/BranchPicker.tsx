// Branch scope and branch mutations. Seat rows retain their live presence; local and remote rows
// act on the selected checkout through the scoped native commands.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowDownAZ, Clock, GitBranch as GitBranchIcon, MoreHorizontal, Search } from "lucide-react";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { Seg } from "../../ui/Seg";
import { PRESENCE_COLOR, PRESENCE_LABEL, seatLabel } from "../../ui/identity";
import { groupBranches, type SeatInfo } from "./model";
import { SectionLabel } from "./parts";
import {
  branchMutationRefusal, scopeBranchCreate, scopeBranchDelete, scopeBranchMerge, scopeBranchRebase, scopeBranchRename, scopeBranchSwitch, scopeBranches,
  type GitBranch, type GitBranchResult, type GitDirtySwitch, type GitScopeArg,
} from "./scopeGitApi";
import { useShellMode } from "../../shell/shellMode";
import type { ScopeSnapshot } from "./useScopeGit";

export type PickerActions = {
  onCheckout: () => void;
  onSeat: (seat: string) => void;
  onCompare: (seat: string) => void;
  onOpenPr: (seat: string) => void;
  onMessage: (seat: string) => void;
  onCopy: (text: string) => void;
};

type ErrorHandler = (message: string) => void;
const errorMessage = (error: Error | string) => error instanceof Error ? error.message : String(error);

function Dot({ presence }: { presence: SeatInfo["presence"] }) {
  return <span role="img" aria-label={PRESENCE_LABEL[presence]} title={PRESENCE_LABEL[presence]} className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: PRESENCE_COLOR[presence] }} />;
}

function MenuRow({ label, hint, onClick, disabled }: { label: string; hint?: string; onClick?: () => void; disabled?: string | null }) {
  return (
    <button type="button" role="menuitem" disabled={!!disabled} title={disabled ?? hint} onClick={onClick}
      className="v2-hover flex w-full flex-col items-start rounded-md border-0 bg-transparent px-2 py-1 text-left text-[12px] text-[var(--v2-text-2)] disabled:opacity-45">
      {label}{(disabled ?? hint) && <span className="text-[10.5px] text-[var(--v2-muted)]">{disabled ?? hint}</span>}
    </button>
  );
}

function Dialog({ label, children, onClose }: { label: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-5" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-label={label} className="flex w-[420px] max-w-full flex-col gap-3 rounded-xl border border-[var(--v2-edge-2)] bg-[var(--v2-panel)] p-4 shadow-2xl">
        {children}
      </div>
    </div>
  );
}

export function CreateBranchDialog({ project, scope, sha, onClose, onCreated, onError }: {
  project: string; scope: GitScopeArg; sha?: string; onClose: () => void; onCreated: () => void; onError: ErrorHandler;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const create = () => {
    setBusy(true);
    void scopeBranchCreate(project, scope, name.trim(), sha).then(() => { onCreated(); onClose(); })
      .catch(error => onError(errorMessage(error))).finally(() => setBusy(false));
  };
  return (
    <Dialog label={sha ? `Create a branch at ${sha.slice(0, 7)}` : "Create branch"} onClose={onClose}>
      <h2 className="m-0 text-[15px] text-[var(--v2-text)]">Create a branch {sha ? `at ${sha.slice(0, 7)}` : "from HEAD"}</h2>
      <label className="text-[12px] text-[var(--v2-muted)]" htmlFor="v2-new-branch">Branch name</label>
      <input id="v2-new-branch" aria-label="New branch name" autoFocus value={name} onChange={event => setName(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter" && name.trim() && !busy) create(); }}
        className="rounded-md border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] px-2.5 py-2 text-[13px] text-[var(--v2-text)] outline-none" />
      <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabledReason={!name.trim() ? "Enter a branch name" : busy ? "Creating branch" : null} onClick={create}>Create branch</Button></div>
    </Dialog>
  );
}

type BranchOps = {
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

function SeatMenu({ s, acts, ops, onClose }: { s: SeatInfo & { branchLabel: string }; acts: PickerActions; ops: BranchOps; onClose: () => void }) {
  const run = (f: () => void) => () => { f(); onClose(); };
  const ahead = s.ahead ? `${s.ahead} ahead of main` : "nothing ahead of main";
  const branch = ops.branch(s.branchLabel);
  const main = ops.branch("main");
  const rebaseReason = s.presence === "working" ? `${seatLabel(s.seat)} is working; rebase after the turn ends`
    : !branch?.current ? "Open this seat's worktree; rebase acts on its current branch" : !main ? "main is not present in this checkout" : null;
  return (
    <div role="menu" aria-label={`${s.branchLabel} actions`} className="absolute right-2 top-full z-10 w-[280px] rounded-[10px] border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] p-1 shadow-[0_12px_32px_rgba(0,0,0,0.45)]">
      <div className="flex items-center gap-1.5 px-2 py-1 text-[11.5px] text-[var(--v2-muted)]"><Avatar name={s.seat} size={16} /><span className="v2-mono text-[var(--v2-text)]">{s.branchLabel}</span> · {ahead}</div>
      <SectionLabel>Open</SectionLabel>
      <MenuRow label="Open its worktree in a tab" onClick={run(() => acts.onSeat(s.seat))} />
      <MenuRow label={`Message ${seatLabel(s.seat)}`} onClick={run(() => acts.onMessage(s.seat))} />
      <SectionLabel>With current branch</SectionLabel>
      <MenuRow label="Crew review against main" disabled="No crew review start command from the desktop yet." />
      <MenuRow label="Compare with main" onClick={run(() => acts.onCompare(s.seat))} />
      <MenuRow label="Open pull request" onClick={run(() => acts.onOpenPr(s.seat))} />
      <MenuRow label={`Merge ${s.branchLabel} into current`} disabled={!branch ? "Reading branches" : ops.mutationReason()} onClick={branch ? run(() => ops.integrate("merge", branch)) : undefined} />
      <MenuRow label="Rebase this seat branch onto main" disabled={!branch ? "Reading branches" : rebaseReason} onClick={branch && main ? run(() => ops.integrate("rebase", main)) : undefined} />
      <SectionLabel>Branch</SectionLabel>
      <MenuRow label="Copy name" onClick={run(() => acts.onCopy(s.branchLabel))} />
      <MenuRow label="Rename branch…" disabled={!branch ? "Reading branches" : ops.renameReason(branch)} onClick={branch ? run(() => ops.rename(branch)) : undefined} />
      <MenuRow label="Delete branch…" disabled={!branch ? "Reading branches" : ops.deleteReason(branch)} onClick={branch ? run(() => ops.remove(branch)) : undefined} />
    </div>
  );
}

function SeatRow({ s, current, acts, ops, onClose }: { s: SeatInfo & { branchLabel: string }; current: boolean; acts: PickerActions; ops: BranchOps; onClose: () => void }) {
  const [menu, setMenu] = useState(false);
  return (
    <div className="relative">
      <div data-current={current || undefined} className={`flex items-center gap-2 px-3 py-1.5 text-[12px] ${current ? "bg-[var(--v2-accent-soft)]" : "hover:bg-[var(--v2-raised)]"}`}>
        <button type="button" onClick={() => { acts.onSeat(s.seat); onClose(); }} className="flex min-w-0 flex-1 items-center gap-2 border-0 bg-transparent p-0 text-left text-[var(--v2-text)]">
          <GitBranchIcon size={13} aria-hidden className="shrink-0 text-[var(--v2-muted)]" />
          <span className="v2-mono shrink-0 text-[12px]">{s.branchLabel}</span>
          <Dot presence={s.presence} />
          <span className="flex min-w-0 items-center gap-1.5 truncate text-[11.5px] text-[var(--v2-muted)]"><Avatar name={s.seat} size={16} />{seatLabel(s.seat)} · {PRESENCE_LABEL[s.presence]}{s.machine ? ` · ${s.machine}` : ""}</span>
        </button>
        {s.ahead ? <span className="v2-mono shrink-0 text-[11px] text-[var(--v2-muted)]" title={`${s.ahead} commits ahead of main`}>↑{s.ahead}</span> : null}
        <IconButton label={`More actions for ${s.branchLabel}`} title="More actions" size={22} onClick={() => setMenu(m => !m)}><MoreHorizontal size={13} aria-hidden /></IconButton>
      </div>
      {menu && <SeatMenu s={s} acts={acts} ops={ops} onClose={() => { setMenu(false); onClose(); }} />}
    </div>
  );
}

function age(timestamp: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() / 1000 - timestamp) / 60));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function BranchRow({ branch, ops }: { branch: GitBranch; ops: BranchOps }) {
  const [menu, setMenu] = useState(false);
  const run = (action: () => void) => () => { setMenu(false); action(); };
  const integrateReason = branch.current ? "This is already the current branch" : ops.mutationReason();
  return (
    <div className="relative px-1">
      <div data-current={branch.current || undefined} className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] ${branch.current ? "bg-[var(--v2-accent-soft)]" : "hover:bg-[var(--v2-raised)]"}`}>
        <button type="button" disabled={!!ops.switchReason(branch)} title={ops.switchReason(branch) ?? `Switch to ${branch.name}`} onClick={() => ops.switchTo(branch)}
          className="flex min-w-0 flex-1 items-center gap-2 border-0 bg-transparent p-0 text-left text-[var(--v2-text)] disabled:opacity-45">
          <GitBranchIcon size={13} aria-hidden className="shrink-0 text-[var(--v2-muted)]" /><span className="v2-mono truncate">{branch.name}</span>
        </button>
        <span className="shrink-0 text-[10.5px] text-[var(--v2-muted)]">{age(branch.committed_at)}</span>
        {(branch.ahead || branch.behind) ? <span className="v2-mono shrink-0 text-[10.5px] text-[var(--v2-muted)]">{branch.ahead ? `↑${branch.ahead}` : ""}{branch.behind ? ` ↓${branch.behind}` : ""}</span> : null}
        <IconButton label={`More actions for ${branch.name}`} title="Branch actions" size={22} onClick={() => setMenu(value => !value)}><MoreHorizontal size={13} aria-hidden /></IconButton>
      </div>
      {menu && <div role="menu" aria-label={`${branch.name} actions`} className="absolute right-2 top-full z-20 w-[280px] rounded-[10px] border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] p-1 shadow-xl">
        <MenuRow label={`Switch to ${branch.name}`} disabled={ops.switchReason(branch)} onClick={run(() => ops.switchTo(branch))} />
        <MenuRow label={`Merge into ${branch.current ? "current branch" : "the current branch"}`} hint={`Merge ${branch.name}`} disabled={integrateReason} onClick={run(() => ops.integrate("merge", branch))} />
        <MenuRow label="Rebase current onto this branch" disabled={integrateReason} onClick={run(() => ops.integrate("rebase", branch))} />
        {!branch.remote && <MenuRow label="Rename branch…" disabled={ops.renameReason(branch)} onClick={run(() => ops.rename(branch))} />}
        {!branch.remote && <MenuRow label="Delete branch…" disabled={ops.deleteReason(branch)} onClick={run(() => ops.remove(branch))} />}
        <MenuRow label="Copy name" onClick={run(() => navigator.clipboard?.writeText(branch.name))} />
      </div>}
    </div>
  );
}

type DialogState =
  | { kind: "create" }
  | { kind: "switch"; branch: GitBranch }
  | { kind: "rename"; branch: GitBranch }
  | { kind: "delete"; branch: GitBranch; unique: number }
  | null;

export function BranchPicker({ project, seats, snap, scope, acts, onClose, onMutated, onError, onOpenConflict }: {
  project: string; seats: SeatInfo[]; snap: ScopeSnapshot | null; scope: GitScopeArg; acts: PickerActions; onClose: () => void;
  onMutated: () => void; onError: ErrorHandler; onOpenConflict: (path: string | null) => void;
}) {
  const mode = useShellMode();
  const [filter, setFilter] = useState("");
  const [show, setShow] = useState<"all" | "seats">("all");
  const [sort, setSort] = useState<"recent" | "name">("recent");
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState(false);
  const groups = useMemo(() => groupBranches({ seats, filter, show, sort }), [seats, filter, show, sort]);
  useEffect(() => {
    let alive = true;
    void scopeBranches(project, scope).then(result => { if (alive) { setBranches(result.branches); setReadError(null); } })
      .catch(error => { if (alive) setReadError(errorMessage(error)); });
    return () => { alive = false; };
  }, [project, scope, revision]);
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
    if (owner && owner.seat !== scope) return `Open ${seatLabel(owner.seat)}'s worktree to rename its branch`;
    return mutationReason();
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
  const ops: BranchOps = { branch, switchTo, rename: item => setDialog({ kind: "rename", branch: item }), remove, integrate, mutationReason, switchReason, renameReason, deleteReason };
  return (
    <div role="dialog" aria-label="Switch branch" className="absolute left-0 top-[calc(100%+6px)] z-50 w-[560px] max-w-[92vw] rounded-xl border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] shadow-[0_16px_40px_rgba(0,0,0,0.5)]">
      <div className="flex items-center gap-2 border-b border-[var(--v2-edge)] px-3 py-2">
        <Search size={13} aria-hidden className="text-[var(--v2-muted)]" />
        <label htmlFor="v2-branch-filter" className="sr-only">Switch to a branch or seat</label>
        <input id="v2-branch-filter" autoFocus value={filter} onChange={event => setFilter(event.target.value)} placeholder="Switch to a branch, seat or worktree…"
          className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] text-[var(--v2-text)] outline-none" />
        <IconButton label={sort === "recent" ? "Sort: most recent first" : "Sort: A to Z"} title="Sort: most recent first, or A to Z" size={24} onClick={() => setSort(value => (value === "recent" ? "name" : "recent"))}>
          {sort === "recent" ? <Clock size={13} aria-hidden /> : <ArrowDownAZ size={13} aria-hidden />}
        </IconButton>
        <Seg label="Show" value={show} onChange={setShow} options={[{ value: "all", label: "All" }, { value: "seats", label: "Seats only" }]} />
      </div>
      <div className="max-h-[60vh] overflow-y-auto pb-1">
        {groups.checkout.length > 0 && <>
          <SectionLabel>This checkout</SectionLabel>
          <button type="button" onClick={() => { acts.onCheckout(); onClose(); }} data-current={scope === null || undefined}
            className={`flex w-full items-center gap-2 border-0 px-3 py-1.5 text-left text-[12px] ${scope === null ? "bg-[var(--v2-accent-soft)]" : "bg-transparent hover:bg-[var(--v2-raised)]"}`}>
            <GitBranchIcon size={13} aria-hidden className="text-[var(--v2-muted)]" /><span className="text-[var(--v2-text)]">Project checkout</span>
            <span className="v2-mono text-[11.5px] text-[var(--v2-muted)]">· {snap?.branch ?? "reading branch"}</span>
          </button>
        </>}
        <SectionLabel>Seats · each in its own worktree</SectionLabel>
        {groups.seats.length === 0 && <div className="px-3 py-1.5 text-[12px] text-[var(--v2-muted)]">{seats.some(seat => seat.hasWorktree) ? "No seat matches." : "No seat has a worktree for this project."}</div>}
        {groups.seats.map(seat => <SeatRow key={seat.seat} s={seat} current={scope === seat.seat} acts={acts} ops={ops} onClose={onClose} />)}
        {show === "all" && <>
          <SectionLabel>Other local</SectionLabel>
          {readError && <div role="alert" className="px-3 py-1.5 text-[12px] text-[var(--v2-bad)]">{readError}</div>}
          {!readError && locals.length === 0 && <div className="px-3 py-1.5 text-[12px] text-[var(--v2-muted)]">No other local branches match.</div>}
          {locals.map(item => <BranchRow key={item.name} branch={item} ops={ops} />)}
          <SectionLabel>Remote</SectionLabel>
          {!readError && remotes.length === 0 && <div className="px-3 py-1.5 text-[12px] text-[var(--v2-muted)]">No remote branches match.</div>}
          {remotes.map(item => <BranchRow key={item.name} branch={item} ops={ops} />)}
        </>}
      </div>
      <div className="flex items-center gap-2 border-t border-[var(--v2-edge)] px-3 py-2 text-[11.5px] text-[var(--v2-muted)]">
        <Button disabledReason={mutationReason()} onClick={() => setDialog({ kind: "create" })}>Create branch…</Button>
        <button type="button" disabled title="Starting a seat on a branch needs the crew launcher from the desktop. Not wired yet." className="rounded-md border border-[var(--v2-edge-2)] bg-transparent px-2 py-1 text-[var(--v2-text-2)] disabled:opacity-45">Start a seat on a branch…</button>
        <span className="flex-1" />
        <span>⏎ switch</span>
      </div>
      {dialog?.kind === "create" && <CreateBranchDialog project={project} scope={scope} onClose={() => setDialog(null)} onCreated={finish} onError={onError} />}
      {dialog?.kind === "switch" && <Dialog label={`Switch to ${dialog.branch.name}`} onClose={() => setDialog(null)}>
        <h2 className="m-0 text-[15px] text-[var(--v2-text)]">Uncommitted files</h2>
        <p className="m-0 text-[12.5px] leading-relaxed text-[var(--v2-text-2)]">Bring {snap?.status.length ?? 0} changed path(s) to {dialog.branch.name}, or stash them with a message naming that branch.</p>
        <div className="flex justify-end gap-2"><Button onClick={() => setDialog(null)}>Cancel</Button><Button disabledReason={busy ? "Switching" : null} onClick={() => switchTo(dialog.branch, "stash")}>Stash and switch</Button><Button variant="primary" disabledReason={busy ? "Switching" : null} onClick={() => switchTo(dialog.branch, "bring")}>Bring changes</Button></div>
      </Dialog>}
      {dialog?.kind === "rename" && <RenameDialog branch={dialog.branch} busy={busy} onClose={() => setDialog(null)} onRename={next => {
        setBusy(true);
        void scopeBranchRename(project, scope, dialog.branch.name, next).then(() => { setDialog(null); finish(); })
          .catch(error => onError(errorMessage(error))).finally(() => setBusy(false));
      }} />}
      {dialog?.kind === "delete" && <Dialog label={`Delete ${dialog.branch.name}`} onClose={() => setDialog(null)}>
        <h2 className="m-0 text-[15px] text-[var(--v2-text)]">Delete unmerged branch?</h2>
        <p className="m-0 text-[12.5px] leading-relaxed text-[var(--v2-text-2)]">{dialog.branch.name} has {dialog.unique} commit{dialog.unique === 1 ? "" : "s"} that the current branch does not have. Deleting it can make those commits unreachable.</p>
        <div className="flex justify-end gap-2"><Button onClick={() => setDialog(null)}>Cancel</Button><Button variant="danger" disabledReason={busy ? "Deleting" : null} onClick={() => remove(dialog.branch, true)}>Delete {dialog.branch.name}</Button></div>
      </Dialog>}
    </div>
  );
}

function RenameDialog({ branch, busy, onClose, onRename }: { branch: GitBranch; busy: boolean; onClose: () => void; onRename: (name: string) => void }) {
  const [name, setName] = useState(branch.name);
  return <Dialog label={`Rename ${branch.name}`} onClose={onClose}>
    <h2 className="m-0 text-[15px] text-[var(--v2-text)]">Rename {branch.name}</h2>
    <input aria-label="New branch name" autoFocus value={name} onChange={event => setName(event.target.value)}
      className="rounded-md border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] px-2.5 py-2 text-[13px] text-[var(--v2-text)] outline-none" />
    <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabledReason={!name.trim() || name === branch.name ? "Enter a new branch name" : busy ? "Renaming" : null} onClick={() => onRename(name.trim())}>Rename branch</Button></div>
  </Dialog>;
}

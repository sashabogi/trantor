// Branch scope and branch mutations. Seat rows retain their live presence; local and remote rows
// act on the selected checkout through the scoped native commands.
import { useState } from "react";
import { ArrowDownAZ, Clock, GitBranch as GitBranchIcon, MoreHorizontal, Search } from "lucide-react";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { Seg } from "../../ui/Seg";
import { PRESENCE_COLOR, PRESENCE_LABEL, seatLabel } from "../../ui/identity";
import { type SeatInfo } from "./model";
import { SectionLabel } from "./parts";
import { BranchDialogs } from "./BranchDialogs";
import { useBranchOps, useBranchRows, type BranchOps, type ErrorHandler } from "./useBranchOps";
import type { GitBranch, GitScopeArg } from "./scopeGitApi";
import type { ScopeSnapshot } from "./useScopeGit";

export { CreateBranchDialog } from "./BranchDialogs";

/** A row menu opens inside the scrolling list; this scrolls the list so the whole menu shows (#14100 drill). */
const showWhole = (menu: HTMLDivElement | null) => { menu?.scrollIntoView?.({ block: "nearest" }); };

export type PickerActions = {
  onCheckout: () => void;
  onSeat: (seat: string) => void;
  onCompare: (seat: string) => void;
  onMessage: (seat: string) => void;
  onCopy: (text: string) => void;
};

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

function SeatMenu({ s, acts, ops, onClose }: { s: SeatInfo & { branchLabel: string }; acts: PickerActions; ops: BranchOps; onClose: () => void }) {
  const run = (f: () => void) => () => { f(); onClose(); };
  const ahead = s.ahead ? `${s.ahead} ahead of main` : "nothing ahead of main";
  const branch = ops.branch(s.branchLabel);
  const main = ops.branch("main");
  const rebaseReason = s.presence === "working" ? `${seatLabel(s.seat)} is working; rebase after the turn ends`
    : !branch?.current ? "Open this seat's worktree; rebase acts on its current branch" : !main ? "main is not present in this checkout" : null;
  return (
    <div role="menu" ref={showWhole} aria-label={`${s.branchLabel} actions`} className="absolute right-2 top-full z-10 w-[280px] rounded-[10px] border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] p-1 shadow-[var(--v2-shadow-menu)]">
      <div className="flex items-center gap-1.5 px-2 py-1 text-[11.5px] text-[var(--v2-muted)]"><Avatar name={s.seat} size={16} /><span className="v2-mono text-[var(--v2-text)]">{s.branchLabel}</span> · {ahead}</div>
      <SectionLabel>Open</SectionLabel>
      <MenuRow label="Open its worktree in a tab" onClick={run(() => acts.onSeat(s.seat))} />
      <MenuRow label={`Message ${seatLabel(s.seat)}`} onClick={run(() => acts.onMessage(s.seat))} />
      <SectionLabel>With current branch</SectionLabel>
      <MenuRow label="Compare with main" onClick={run(() => acts.onCompare(s.seat))} />
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
      {menu && <div role="menu" ref={showWhole} aria-label={`${branch.name} actions`} className="absolute right-2 top-full z-20 w-[280px] rounded-[10px] border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] p-1 shadow-xl">
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

export function BranchPicker({ project, seats, snap, scope, acts, onClose, onMutated, onError, onOpenConflict }: {
  project: string; seats: SeatInfo[]; snap: ScopeSnapshot | null; scope: GitScopeArg; acts: PickerActions; onClose: () => void;
  onMutated: () => void; onError: ErrorHandler; onOpenConflict: (path: string | null) => void;
}) {
  const branchState = useBranchOps({ project, seats, snap, scope, onClose, onMutated, onError, onOpenConflict });
  const { filter, setFilter, show, setShow, sort, setSort, groups, locals, remotes } = useBranchRows(seats, branchState.branches);
  const { ops, dialog, setDialog, busy } = branchState;
  return (
    <div role="dialog" aria-label="Switch branch" className="absolute left-0 top-[calc(100%+6px)] z-50 w-[560px] max-w-[92vw] rounded-xl border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] shadow-[var(--v2-shadow-dialog)]">
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
          {branchState.readError && <div role="alert" className="px-3 py-1.5 text-[12px] text-[var(--v2-bad)]">{branchState.readError}</div>}
          {!branchState.readError && locals.length === 0 && <div className="px-3 py-1.5 text-[12px] text-[var(--v2-muted)]">No other local branches match.</div>}
          {locals.map(item => <BranchRow key={item.name} branch={item} ops={ops} />)}
          <SectionLabel>Remote</SectionLabel>
          {!branchState.readError && remotes.length === 0 && <div className="px-3 py-1.5 text-[12px] text-[var(--v2-muted)]">No remote branches match.</div>}
          {remotes.map(item => <BranchRow key={item.name} branch={item} ops={ops} />)}
        </>}
      </div>
      <div className="flex items-center gap-2 border-t border-[var(--v2-edge)] px-3 py-2 text-[11.5px] text-[var(--v2-muted)]">
        <Button disabledReason={ops.mutationReason()} onClick={() => setDialog({ kind: "create" })}>Create branch…</Button>
        <span className="flex-1" />
        <span>⏎ switch</span>
      </div>
      <BranchDialogs dialog={dialog} project={project} scope={scope} statusCount={snap?.status.length ?? 0} busy={busy}
        onDismiss={() => setDialog(null)} onCreated={branchState.finish} onError={onError} onSwitch={branchState.switchTo}
        onRename={branchState.rename} onDelete={branchState.remove} />
    </div>
  );
}

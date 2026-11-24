// The branch picker popover (#13988): This checkout, Seats (each on its seat/* branch with its avatar
// and live state), Other local and Remote. Switching a row changes which scope the screen reads, so
// no checkout moves and no uncommitted work needs stashing.
import { useMemo, useState } from "react";
import { ArrowDownAZ, Clock, GitBranch, MoreHorizontal, Search } from "lucide-react";
import { Avatar } from "../../ui/Avatar";
import { IconButton } from "../../ui/IconButton";
import { Seg } from "../../ui/Seg";
import { PRESENCE_COLOR, PRESENCE_LABEL, seatLabel } from "../../ui/identity";
import { groupBranches, type SeatInfo } from "./model";
import { NotWiredBlock, SectionLabel } from "./parts";

export type PickerActions = {
  onCheckout: () => void;
  onSeat: (seat: string) => void;
  onCompare: (seat: string) => void;
  onOpenPr: (seat: string) => void;
  onMessage: (seat: string) => void;
  onCopy: (text: string) => void;
};

function Dot({ presence }: { presence: SeatInfo["presence"] }) {
  return <span role="img" aria-label={PRESENCE_LABEL[presence]} title={PRESENCE_LABEL[presence]} className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: PRESENCE_COLOR[presence] }} />;
}

function MenuRow({ label, hint, onClick, disabled }: { label: string; hint?: string; onClick?: () => void; disabled?: string }) {
  return (
    <button type="button" role="menuitem" disabled={!!disabled} title={disabled ?? hint} onClick={onClick}
      className="v2-hover flex w-full flex-col items-start rounded-md border-0 bg-transparent px-2 py-1 text-left text-[12px] text-[var(--v2-text-2)] disabled:opacity-45">
      {label}{(disabled ?? hint) && <span className="text-[10.5px] text-[var(--v2-muted)]">{disabled ?? hint}</span>}
    </button>
  );
}

function SeatMenu({ s, acts, onClose }: { s: SeatInfo & { branchLabel: string }; acts: PickerActions; onClose: () => void }) {
  const run = (f: () => void) => () => { f(); onClose(); };
  const ahead = s.ahead ? `${s.ahead} ahead of main` : "nothing ahead of main";
  return (
    <div role="menu" aria-label={`${s.branchLabel} actions`} className="absolute right-2 top-full z-10 w-[260px] rounded-[10px] border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] p-1 shadow-[0_12px_32px_rgba(0,0,0,0.45)]">
      <div className="flex items-center gap-1.5 px-2 py-1 text-[11.5px] text-[var(--v2-muted)]"><Avatar name={s.seat} size={16} /><span className="v2-mono text-[var(--v2-text)]">{s.branchLabel}</span> · {ahead}</div>
      <SectionLabel>Open</SectionLabel>
      <MenuRow label="Open its worktree in a tab" onClick={run(() => acts.onSeat(s.seat))} />
      <MenuRow label={`Message ${seatLabel(s.seat)}`} onClick={run(() => acts.onMessage(s.seat))} />
      <SectionLabel>With main</SectionLabel>
      <MenuRow label="Crew review against main" disabled="No crew review start command from the desktop yet." />
      <MenuRow label="Compare with main" onClick={run(() => acts.onCompare(s.seat))} />
      <MenuRow label="Open pull request" onClick={run(() => acts.onOpenPr(s.seat))} />
      <MenuRow label="Merge into main" disabled="No merge command yet. A merge also waits for the drill." />
      <MenuRow label="Rebase onto main" disabled="No rebase command yet." />
      <SectionLabel>Branch</SectionLabel>
      <MenuRow label="Copy name" onClick={run(() => acts.onCopy(s.branchLabel))} />
      <MenuRow label="Delete branch…" disabled="Deleting needs a git branch command. Not wired yet." />
    </div>
  );
}

function SeatRow({ s, current, acts, onClose }: { s: SeatInfo & { branchLabel: string }; current: boolean; acts: PickerActions; onClose: () => void }) {
  const [menu, setMenu] = useState(false);
  return (
    <div className="relative">
      <div data-current={current || undefined} className={`flex items-center gap-2 px-3 py-1.5 text-[12px] ${current ? "bg-[var(--v2-accent-soft)]" : "hover:bg-[var(--v2-raised)]"}`}>
        <button type="button" onClick={() => { acts.onSeat(s.seat); onClose(); }} className="flex min-w-0 flex-1 items-center gap-2 border-0 bg-transparent p-0 text-left text-[var(--v2-text)]">
          <GitBranch size={13} aria-hidden className="shrink-0 text-[var(--v2-muted)]" />
          <span className="v2-mono shrink-0 text-[12px]">{s.branchLabel}</span>
          <Dot presence={s.presence} />
          <span className="flex min-w-0 items-center gap-1.5 truncate text-[11.5px] text-[var(--v2-muted)]"><Avatar name={s.seat} size={16} />{seatLabel(s.seat)} · {PRESENCE_LABEL[s.presence]}{s.machine ? ` · ${s.machine}` : ""}</span>
        </button>
        {s.ahead ? <span className="v2-mono shrink-0 text-[11px] text-[var(--v2-muted)]" title={`${s.ahead} commits ahead of main`}>↑{s.ahead}</span> : null}
        <IconButton label={`More actions for ${s.branchLabel}`} title="More actions" size={22} onClick={() => setMenu(m => !m)}><MoreHorizontal size={13} aria-hidden /></IconButton>
      </div>
      {menu && <SeatMenu s={s} acts={acts} onClose={() => { setMenu(false); onClose(); }} />}
    </div>
  );
}

export function BranchPicker({ seats, scope, acts, onClose }: { seats: SeatInfo[]; scope: string | null; acts: PickerActions; onClose: () => void }) {
  const [filter, setFilter] = useState("");
  const [show, setShow] = useState<"all" | "seats">("all");
  const [sort, setSort] = useState<"recent" | "name">("recent");
  const groups = useMemo(() => groupBranches({ seats, filter, show, sort }), [seats, filter, show, sort]);
  return (
    <div role="dialog" aria-label="Switch branch" className="absolute left-0 top-[calc(100%+6px)] z-50 w-[520px] max-w-[92vw] rounded-xl border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] shadow-[0_16px_40px_rgba(0,0,0,0.5)]">
      <div className="flex items-center gap-2 border-b border-[var(--v2-edge)] px-3 py-2">
        <Search size={13} aria-hidden className="text-[var(--v2-muted)]" />
        <label htmlFor="v2-branch-filter" className="sr-only">Switch to a branch or seat</label>
        <input id="v2-branch-filter" autoFocus value={filter} onChange={e => setFilter(e.target.value)} placeholder="Switch to a branch, seat or worktree…"
          className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] text-[var(--v2-text)] outline-none" />
        <IconButton label={sort === "recent" ? "Sort: most recent first" : "Sort: A to Z"} title="Sort: most recent first, or A to Z" size={24} onClick={() => setSort(s => (s === "recent" ? "name" : "recent"))}>
          {sort === "recent" ? <Clock size={13} aria-hidden /> : <ArrowDownAZ size={13} aria-hidden />}
        </IconButton>
        <Seg label="Show" value={show} onChange={setShow} options={[{ value: "all", label: "All" }, { value: "seats", label: "Seats only" }]} />
      </div>
      <div className="max-h-[60vh] overflow-y-auto pb-1">
        {groups.checkout.length > 0 && <>
          <SectionLabel>This checkout</SectionLabel>
          <button type="button" onClick={() => { acts.onCheckout(); onClose(); }} data-current={scope === null || undefined}
            className={`flex w-full items-center gap-2 border-0 px-3 py-1.5 text-left text-[12px] ${scope === null ? "bg-[var(--v2-accent-soft)]" : "bg-transparent hover:bg-[var(--v2-raised)]"}`}>
            <GitBranch size={13} aria-hidden className="text-[var(--v2-muted)]" /><span className="text-[var(--v2-text)]">Project checkout</span>
            <span className="text-[11.5px] text-[var(--v2-muted)]">· branch name is not readable here yet</span>
          </button>
        </>}
        <SectionLabel>Seats · each in its own worktree</SectionLabel>
        {groups.seats.length === 0 && <div className="px-3 py-1.5 text-[12px] text-[var(--v2-muted)]">{seats.some(s => s.hasWorktree) ? "No seat matches." : "No seat has a worktree for this project."}</div>}
        {groups.seats.map(s => <SeatRow key={s.seat} s={s} current={scope === s.seat} acts={acts} onClose={onClose} />)}
        {show === "all" && <>
          <SectionLabel>Other local</SectionLabel>
          <div className="px-3 pb-1"><NotWiredBlock title="Other local branches" line="Listing branches that are not seats needs a git branch command. Not wired yet." /></div>
          <SectionLabel>Remote</SectionLabel>
          <div className="px-3 pb-1"><NotWiredBlock title="Remote branches" line="Counting branches on origin needs a git ls-remote command. Not wired yet." /></div>
        </>}
      </div>
      <div className="flex items-center gap-2 border-t border-[var(--v2-edge)] px-3 py-2 text-[11.5px] text-[var(--v2-muted)]">
        <button type="button" disabled title="Creating a branch needs a git branch command. Not wired yet." className="rounded-md border border-[var(--v2-edge-2)] bg-transparent px-2 py-1 text-[var(--v2-text-2)] disabled:opacity-45">Create branch…</button>
        <button type="button" disabled title="Starting a seat on a branch needs the crew launcher from the desktop. Not wired yet." className="rounded-md border border-[var(--v2-edge-2)] bg-transparent px-2 py-1 text-[var(--v2-text-2)] disabled:opacity-45">Start a seat on a branch…</button>
        <span className="flex-1" />
        <span>⏎ switch</span>
      </div>
    </div>
  );
}

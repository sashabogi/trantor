// The inspector strip for the selected seat: who and where, card, branch, may-do, actions (#13987).
import { useEffect, useState } from "react";
import { ArrowRightToLine, Code2, GitBranch, MessageCircle, Square, SquareKanban, Shuffle, X } from "lucide-react";
import type { Card } from "../../../shared/api/client";
import { gitPanel } from "../../../features/code/gitApi";
import { Avatar } from "../../ui/Avatar";
import { Chip } from "../../ui/Chip";
import { IconButton } from "../../ui/IconButton";
import { seatAgent } from "../../ui/identity";
import type { Navigate } from "../../routes";
import { PopMenu } from "./PopMenu";
import type { SeatView } from "./seatModel";
import type { MayDo } from "./useWorkspaceData";
import type { Crew } from "./useCrew";

type Branch = { name: string; ahead: number | null } | null;

/** The seat's own worktree branch and how far ahead it is, from the classic git bridge; null when unreadable. */
function useBranch(project: string, seat: SeatView): Branch {
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

export function Inspector({ project, seat, card, mayDo, crew, onNavigate, onMessage }: {
  project: string; seat: SeatView; card: Card | undefined; mayDo: MayDo; crew: Crew;
  onNavigate: Navigate; onMessage: () => void;
}) {
  const branch = useBranch(project, seat);
  const name = seat.label;
  const status = seat.target.status;
  const orchNote = "This is your own session; manage it from its window";
  return (
    <div className="flex flex-wrap items-center gap-3.5 border-b border-[var(--v2-edge)] bg-[var(--v2-sunken)] px-5 py-2.5 text-[12px]">
      <span className="inline-flex items-center gap-2">
        <Avatar name={seat.brand} size={26} />
        <span>
          <span className="font-semibold">{name}</span>
          <span className="block text-[11px] text-[var(--v2-muted)]">{seat.session}{seat.machine ? ` · ${seat.machine}` : ""}</span>
        </span>
      </span>
      {card && (
        <button type="button" title="Open the card on the Board" onClick={() => onNavigate("board")}
          className="v2-hover inline-flex items-center gap-1.5 rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel-2)] px-[9px] py-1 text-[var(--v2-text)]">
          <SquareKanban size={12} className="text-[var(--v2-accent)]" aria-hidden />
          <span className="v2-mono text-[var(--v2-accent)]">#{card.id}</span>
          <span className="max-w-[240px] truncate">{card.title}</span>
        </button>
      )}
      {branch && (
        <span title="Branch, commits ahead of its base" className="v2-mono inline-flex items-center gap-1.5 text-[var(--v2-text-2)]">
          <GitBranch size={12} aria-hidden />{branch.name}{branch.ahead ? ` ↑${branch.ahead}` : ""}
        </span>
      )}
      {mayDo && <Chip title={mayDo.title}>{mayDo.label}</Chip>}
      {status && <span title="What the seat last told the hub" className="max-w-[260px] truncate text-[var(--v2-muted)]">{status}</span>}
      <span title="Seats do not report their context window to the hub yet" className="text-[var(--v2-muted)]">context not reported</span>
      <span className="ml-auto flex gap-0.5">
        <IconButton label={`Message ${name}`} title="Message" onClick={onMessage}><MessageCircle size={15} aria-hidden /></IconButton>
        <IconButton label={`Open ${name}'s worktree in Code`} title="Open its worktree in Code" onClick={() => onNavigate("code")}><Code2 size={15} aria-hidden /></IconButton>
        <IconButton label={`Hand off ${name}'s session`} title="Hand off is wired for the orchestrator only, in its chat panel" disabled><ArrowRightToLine size={15} aria-hidden /></IconButton>
        <PopMenu heading={`Swap ${name} to`} empty="No other agent is installed, enabled and within quota"
          items={crew.available.filter(a => a.id !== seatAgent(seat.session)).map(a => ({ id: a.id, label: a.label, sub: "keeps the card", disabledReason: crew.busy ? "Another seat action is running" : null, onPick: () => void crew.swap(seat.agent, a.id) }))}
          trigger={p => (
            <IconButton {...p} label={`Swap ${name}`} title={seat.isOrchestrator ? orchNote : "Swap model, keep the card"} disabled={seat.isOrchestrator}>
              <Shuffle size={15} aria-hidden />
            </IconButton>
          )} />
        <IconButton label={`Stop ${name}`} title={seat.isOrchestrator ? orchNote : "Stop"} disabled={seat.isOrchestrator || crew.busy}
          onClick={() => void crew.stop(seat.agent)} className="text-[var(--v2-bad)]"><Square size={13} fill="currentColor" aria-hidden /></IconButton>
      </span>
      {crew.notice && (
        <div role="status" className={`flex basis-full items-center gap-2 text-[11.5px] ${crew.notice.failed ? "text-[var(--v2-bad)]" : "text-[var(--v2-muted)]"}`}>
          <span className="min-w-0 flex-1">{crew.notice.text}</span>
          <IconButton label="Dismiss the seat notice" title="Dismiss" size={20} onClick={crew.dismiss}><X size={11} aria-hidden /></IconButton>
        </div>
      )}
    </div>
  );
}

// The seat bar: view tabs, what the seat is on, and its labelled actions in one 32px row (#14351).
// It replaces the old Inspector row and the Terminal and Changes bar.
import { Code2, Ellipsis, GitBranch, Globe, MessageCircle, Shuffle, Square, SquareKanban, X } from "lucide-react";
import type { Card } from "../../../shared/api/client";
import { IconButton } from "../../ui/IconButton";
import { seatAgent } from "../../ui/identity";
import type { Navigate } from "../../routes";
import { openCardSheet } from "../../shell/cardIntent";
import { setOpenIntent } from "../../shell/openIntent";
import { ActionMenu, type ActionItem } from "./ActionMenu";
import { useBranch, worktreeAgent } from "./seatFacts";
import { takesSeatMessage, type SeatView } from "./seatModel";
import type { Crew } from "./useCrew";

export type WorkTab = "terminal" | "changes" | "browser";

// #14505: the browser is the project's, not one seat's, so every seat row — helpers included — gets it.
const viewTabs = (seat: SeatView): { id: WorkTab; label: string }[] =>
  seat.isHelper
    ? [{ id: "terminal", label: "Terminal" }, { id: "browser", label: "Browser" }]
    : [{ id: "terminal", label: "Terminal" }, { id: "changes", label: "Changes" }, { id: "browser", label: "Browser" }];

/** The items of the seat's "..." menu: Swap agent and Stop seat. The orchestrator has none (it is managed from its own window) and a helper is stopped from its tab. */
export function seatMenuItems(seat: SeatView, crew: Crew): ActionItem[] {
  if (seat.isOrchestrator || seat.isHelper || seat.agentInfo) return [];
  const name = seat.label;
  const busy = crew.busy ? "Another seat action is running" : null;
  return [
    { id: "swap", label: "Swap agent", icon: <Shuffle size={13} aria-hidden />, sub: {
      heading: `Swap ${name} to`, empty: "No other agent is installed, enabled and within quota",
      items: crew.available.filter(a => a.id !== seatAgent(seat.session)).map(a => ({ id: a.id, label: a.label, disabledReason: busy, onPick: () => void crew.swap(seat.agent, a.id) })),
    } },
    { id: "stop", label: "Stop seat", danger: true, icon: <Square size={12} fill="currentColor" aria-hidden />, disabledReason: busy, sub: {
      heading: `Stop ${name}?`, items: [{ id: "stop-now", label: `Stop ${name}`, danger: true, onPick: () => void crew.stop(seat.agent) }],
    } },
  ];
}

export function SeatBar({ project, seat, card, crew, tab, onTab, changed, onNavigate, onMessage }: {
  project: string; seat: SeatView; card: Card | undefined; crew: Crew; tab: WorkTab; onTab: (t: WorkTab) => void;
  changed: number; onNavigate: Navigate; onMessage: () => void;
}) {
  const branch = useBranch(project, seat);
  const name = seat.label;
  // Remote seats keep their machine so Code reads their real worktree over SSH.
  const openInCode = () => { setOpenIntent(project, { kind: "source-control", seat: seat.machine ? seat.agent : worktreeAgent(seat) ?? undefined, machine: seat.machine }); onNavigate("code"); };
  const items = seatMenuItems(seat, crew);
  return (
    <div className="shrink-0 border-b border-[var(--v2-edge)] bg-[var(--v2-bg)]">
      <div className="flex h-8 items-stretch gap-3 px-3">
        <div role="tablist" aria-label="Seat views" className="flex items-stretch gap-3.5">
          {viewTabs(seat).map(t => {
            const on = t.id === tab;
            return (
              <button key={t.id} type="button" role="tab" aria-selected={on} onClick={() => onTab(t.id)}
                className={`inline-flex items-center gap-1.5 border-0 border-b-2 bg-transparent px-0.5 text-v2-body font-medium transition-colors ${on ? "border-b-[var(--v2-accent)] text-[var(--v2-text)]" : "border-b-transparent text-[var(--v2-text-2)] hover:text-[var(--v2-text)]"}`}
                style={{ transitionDuration: "var(--v2-dur-1)" }}>
                {t.id === "browser" && <Globe size={12} aria-hidden className="shrink-0" />}
                {t.label}
                {t.id === "changes" && changed > 0 && <span className="v2-mono text-v2-small text-[var(--v2-muted)]">{changed}</span>}
              </button>
            );
          })}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {card && (
            <button type="button" title="Open the card" onClick={() => openCardSheet(project, card.id)}
              className="inline-flex min-w-0 items-center gap-1.5 border-0 bg-transparent p-0 text-v2-body text-[var(--v2-accent)] hover:underline">
              <SquareKanban size={12} aria-hidden className="shrink-0" />
              <span className="v2-mono shrink-0">#{card.id}</span>
              <span className="max-w-[260px] truncate">{card.title}</span>
            </button>
          )}
          {branch && (
            <button type="button" title="Open this seat's worktree in Code" onClick={openInCode}
              className="v2-mono v2-hover inline-flex min-w-0 shrink items-center gap-1.5 rounded-md border border-[var(--v2-edge)] bg-transparent px-1.5 py-px text-v2-small text-[var(--v2-text-2)]">
              <GitBranch size={11} aria-hidden className="shrink-0" /><span className="truncate">{branch.name}{branch.ahead ? ` ↑${branch.ahead}` : ""}</span>
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {takesSeatMessage(seat) && (
            <button type="button" aria-label={`Message ${name}`} title="Message this seat" onClick={onMessage}
              className="v2-hover inline-flex items-center gap-1.5 rounded-md border border-[var(--v2-edge-2)] bg-transparent px-2 py-0.5 text-v2-small font-medium text-[var(--v2-text-2)]">
              <MessageCircle size={12} aria-hidden />Message
            </button>
          )}
          {!seat.isHelper && (
            <IconButton label={`Open ${name}'s worktree in Code`} title="Open in Code" size={24} onClick={openInCode}><Code2 size={14} aria-hidden /></IconButton>
          )}
          {items.length > 0 && (
            <ActionMenu key={seat.key} label={`${name} actions`} items={items}
              trigger={p => <IconButton {...p} label={`More actions for ${name}`} title="More" size={24}><Ellipsis size={14} aria-hidden /></IconButton>} />
          )}
        </div>
      </div>
      {crew.notice && (
        <div role="status" className={`flex items-center gap-2 px-3 pb-1.5 text-v2-small ${crew.notice.failed ? "text-[var(--v2-bad)]" : "text-[var(--v2-muted)]"}`}>
          <span className="min-w-0 flex-1">{crew.notice.text}</span>
          <IconButton label="Dismiss the seat notice" title="Dismiss" size={20} onClick={crew.dismiss}><X size={11} aria-hidden /></IconButton>
        </div>
      )}
    </div>
  );
}

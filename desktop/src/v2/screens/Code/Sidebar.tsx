// The sidebar beside file tabs (#13988): Explorer, Search, the source control sidebar, Agents,
// Cards. The "source" view is the same ScmSidebar the Workspace left column shows
// (#14044): Changes, Files and Recent commits, one flat list with the commit box.
import { Maximize2 } from "lucide-react";
import type { Card, HubClient } from "../../../shared/api/client";
import { useTasks } from "../../../shared/tasks";
import { Avatar } from "../../ui/Avatar";
import { ExplorerTree } from "../../ui/ExplorerTree";
import { IconButton } from "../../ui/IconButton";
import { PRESENCE_LABEL, seatLabel } from "../../ui/identity";
import { ScmSidebar } from "../../ui/ScmSidebar";
import type { SideView } from "./IconBar";
import type { SeatInfo } from "./model";
import { SearchPane, type OpenAt } from "./SearchPane";
import type { ScopeState } from "./useScopeGit";

const CLOSED = new Set(["done", "archived", "cancelled", "rejected"]);

function AgentsPane({ seats, scope, onPick }: { seats: SeatInfo[]; scope: string | null; onPick: (s: string) => void }) {
  if (seats.length === 0) return <div className="p-3 text-v2-body text-[var(--v2-muted)]">No seat sessions for this project.</div>;
  return (
    <div className="flex flex-col py-1">
      {seats.map(s => (
        <button key={s.seat} type="button" disabled={!s.hasWorktree} onClick={() => onPick(s.seat)} aria-pressed={scope === s.seat}
          title={s.hasWorktree ? `Read ${s.branch ?? s.seat}` : "This session has no worktree to read"}
          className="v2-hover flex items-center gap-2 border-0 bg-transparent px-3 py-1.5 text-left text-v2-body text-[var(--v2-text)] disabled:opacity-50">
          <Avatar name={s.seat} size={20} presence={s.presence} />
          <span className="min-w-0 flex-1"><span className="block truncate">{seatLabel(s.seat)}</span><span className="block truncate text-v2-small text-[var(--v2-muted)]">{PRESENCE_LABEL[s.presence]}{s.branch ? ` · ${s.branch}` : ""}</span></span>
          {s.ahead ? <span className="v2-mono text-v2-small text-[var(--v2-muted)]">↑{s.ahead}</span> : null}
        </button>
      ))}
    </div>
  );
}

function CardsPane({ cards }: { cards: Card[] }) {
  const open = cards.filter(c => !CLOSED.has(c.status));
  if (open.length === 0) return <div className="p-3 text-v2-body text-[var(--v2-muted)]">No open cards.</div>;
  return (
    <div className="flex flex-col py-1">
      {open.map(c => (
        <div key={c.id} className="flex items-baseline gap-2 px-3 py-1.5 text-v2-body">
          <span className="v2-mono shrink-0 text-v2-small text-[var(--v2-accent)]">#{c.id}</span>
          <span className="min-w-0 flex-1 truncate text-[var(--v2-text)]" title={c.title}>{c.title}</span>
          <span className="shrink-0 text-v2-small text-[var(--v2-muted)]">{c.status}</span>
        </div>
      ))}
    </div>
  );
}

export type SidebarProps = {
  view: SideView; client: HubClient; project: string; scope: string | null; seats: SeatInfo[]; state: ScopeState;
  selected: string | null; onOpenFile: OpenAt; onOpenChange: (path: string) => void; onOpenCommit: (sha: string) => void;
  onMutated: () => void; onOpenSource: () => void; onPickSeat: (seat: string | null) => void; onOpenConflict: (path: string) => void;
};

function Body(p: SidebarProps) {
  const cards = useTasks(p.client, p.project);
  if (p.view === "explorer") return <div className="min-h-0 flex-1 overflow-y-auto"><ExplorerTree project={p.project} seat={p.scope} onOpen={p.onOpenFile} /></div>;
  if (p.view === "search") return <SearchPane project={p.project} scope={p.scope} onOpen={p.onOpenFile} onMutated={p.onMutated} />;
  if (p.view === "agents") return <AgentsPane seats={p.seats} scope={p.scope} onPick={p.onPickSeat} />;
  return <CardsPane cards={cards} />;
}

const TITLES = { explorer: "Explorer", search: "Search", source: "Source control", agents: "Agents", cards: "Cards" } as const satisfies Record<SideView, string>;

export function Sidebar(p: SidebarProps) {
  // #14250: each sidebar view is its own panel; the border-r it shared with the editor column is gone.
  const panel = "flex w-[280px] shrink-0 flex-col overflow-hidden rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel)]";
  if (p.view === "source") {
    return (
      <aside aria-label="Source control" className={panel}>
        <ScmSidebar project={p.project} scope={p.scope} scopeName={p.scope ?? "project checkout"} state={p.state} seats={p.seats}
          onPickScope={p.onPickSeat} hostPicksWorktree selectedPath={p.selected}
          onMutated={p.onMutated} onOpenFile={p.onOpenFile} onOpenChange={p.onOpenChange} onOpenCommit={p.onOpenCommit} onOpenConflict={p.onOpenConflict}
          actions={<IconButton label="Open the full source control tab" title="Open the full tab" size={24} onClick={p.onOpenSource}><Maximize2 size={13} aria-hidden /></IconButton>} />
      </aside>
    );
  }
  return (
    <aside aria-label={TITLES[p.view]} className={panel}>
      <div className="flex items-center gap-1 border-b border-[var(--v2-edge)] px-3 py-2">
        <span className="flex-1 text-v2-small font-semibold uppercase tracking-[0.06em] text-[var(--v2-muted)]">{TITLES[p.view]}</span>
      </div>
      <Body {...p} />
    </aside>
  );
}

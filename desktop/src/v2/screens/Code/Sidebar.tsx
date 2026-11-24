// The sidebar beside file tabs (#13988): Explorer, Search, a Source control summary, Agents, Cards
// and Problems. The Source control summary is the same list the full tab uses, in a narrow column.
import { useEffect, useState } from "react";
import { Maximize2 } from "lucide-react";
import type { Card, HubClient } from "../../../shared/api/client";
import { useTasks } from "../../../shared/tasks";
import { searchFiles } from "../../../features/code/fileApi";
import { aheadLabel } from "../../../features/code/gitApi";
import { Avatar } from "../../ui/Avatar";
import { ExplorerTree } from "../../ui/ExplorerTree";
import { IconButton } from "../../ui/IconButton";
import { PRESENCE_LABEL, seatLabel } from "../../ui/identity";
import { ChangesList } from "./ChangesList";
import type { SideView } from "./IconBar";
import type { SeatInfo } from "./model";
import { MainCheckoutMark, NotWiredBlock } from "./parts";
import type { ScopeSnapshot } from "./useScopeGit";

const CLOSED = new Set(["done", "archived", "cancelled", "rejected"]);

function SearchPane({ project, scope, onOpen }: { project: string; scope: string | null; onOpen: (p: string) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<string[]>([]);
  useEffect(() => {
    if (!q.trim()) { setHits([]); return; }
    let alive = true;
    searchFiles(project, q, scope ?? undefined).then(h => { if (alive) setHits(h); }).catch(() => { if (alive) setHits([]); });
    return () => { alive = false; };
  }, [project, scope, q]);
  return (
    <div className="flex min-h-0 flex-col">
      <label htmlFor="v2-file-search" className="sr-only">Search files</label>
      <input id="v2-file-search" autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Find a file by name"
        className="m-3 rounded-lg border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] px-2.5 py-1.5 text-[12px] text-[var(--v2-text)] outline-none focus:border-[var(--v2-accent)]" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {hits.map(h => <button key={h} type="button" onClick={() => onOpen(h)} className="v2-hover v2-mono block w-full truncate border-0 bg-transparent px-3 py-1 text-left text-[11.5px] text-[var(--v2-text-2)]">{h}</button>)}
        {q.trim() && hits.length === 0 && <div className="px-3 text-[12px] text-[var(--v2-muted)]">No file matches.</div>}
      </div>
    </div>
  );
}

function AgentsPane({ seats, scope, onPick }: { seats: SeatInfo[]; scope: string | null; onPick: (s: string) => void }) {
  if (seats.length === 0) return <div className="p-3 text-[12px] text-[var(--v2-muted)]">No seat sessions for this project.</div>;
  return (
    <div className="flex flex-col py-1">
      {seats.map(s => (
        <button key={s.seat} type="button" disabled={!s.hasWorktree} onClick={() => onPick(s.seat)} aria-pressed={scope === s.seat}
          title={s.hasWorktree ? `Read ${s.branch ?? s.seat}` : "This session has no worktree to read"}
          className="v2-hover flex items-center gap-2 border-0 bg-transparent px-3 py-1.5 text-left text-[12px] text-[var(--v2-text)] disabled:opacity-50">
          <Avatar name={s.seat} size={20} presence={s.presence} />
          <span className="min-w-0 flex-1"><span className="block truncate">{seatLabel(s.seat)}</span><span className="block truncate text-[10.5px] text-[var(--v2-muted)]">{PRESENCE_LABEL[s.presence]}{s.branch ? ` · ${s.branch}` : ""}</span></span>
          {s.ahead ? <span className="v2-mono text-[10.5px] text-[var(--v2-muted)]">↑{s.ahead}</span> : null}
        </button>
      ))}
    </div>
  );
}

function CardsPane({ cards }: { cards: Card[] }) {
  const open = cards.filter(c => !CLOSED.has(c.status));
  if (open.length === 0) return <div className="p-3 text-[12px] text-[var(--v2-muted)]">No open cards.</div>;
  return (
    <div className="flex flex-col py-1">
      {open.map(c => (
        <div key={c.id} className="flex items-baseline gap-2 px-3 py-1.5 text-[12px]">
          <span className="v2-mono shrink-0 text-[11px] text-[var(--v2-accent)]">#{c.id}</span>
          <span className="min-w-0 flex-1 truncate text-[var(--v2-text)]" title={c.title}>{c.title}</span>
          <span className="shrink-0 text-[10.5px] text-[var(--v2-muted)]">{c.status}</span>
        </div>
      ))}
    </div>
  );
}

export type SidebarProps = {
  view: SideView; client: HubClient; project: string; scope: string | null; seats: SeatInfo[]; snap: ScopeSnapshot | null;
  selected: string | null; onOpenFile: (path: string) => void; onSelectChange: (path: string) => void; onMutated: () => void;
  onOpenSource: () => void; onPickSeat: (seat: string) => void; onOpenConflict: (path: string) => void;
};

function Body(p: SidebarProps) {
  const cards = useTasks(p.client, p.project);
  if (p.view === "explorer") return <div className="min-h-0 flex-1 overflow-y-auto"><ExplorerTree project={p.project} seat={p.scope} onOpen={p.onOpenFile} /></div>;
  if (p.view === "search") return <SearchPane project={p.project} scope={p.scope} onOpen={p.onOpenFile} />;
  if (p.view === "agents") return <AgentsPane seats={p.seats} scope={p.scope} onPick={p.onPickSeat} />;
  if (p.view === "cards") return <CardsPane cards={cards} />;
  if (p.view === "problems") return <div className="p-3"><NotWiredBlock title="Problems and review findings" line="Review findings are not wired into this screen yet, so nothing is counted here." /></div>;
  if (!p.snap) return <div className="p-3 text-[12px] text-[var(--v2-muted)]">Reading git</div>;
  return (
    <>
      <div className="flex items-center gap-2 border-b border-[var(--v2-edge)] px-3 py-2 text-[11.5px] text-[var(--v2-muted)]">
        <span className="v2-mono text-[var(--v2-text)]">{p.snap.branch ?? "project checkout"}</span>
        {!p.snap.seatBacked && <MainCheckoutMark />}
        <span title={p.snap.upstream ?? "no upstream: ahead counts unlanded work against main"}>{aheadLabel(p.snap)}</span>
      </div>
      <ChangesList project={p.project} snap={p.snap} selected={p.selected} onSelect={p.onSelectChange} onMutated={p.onMutated} onOpenConflict={p.onOpenConflict} />
    </>
  );
}

const TITLES = { explorer: "Explorer", search: "Search", source: "Source control", agents: "Agents", cards: "Cards", problems: "Problems" } as const satisfies Record<SideView, string>;

export function Sidebar(p: SidebarProps) {
  return (
    <aside aria-label={TITLES[p.view]} className="flex w-[280px] shrink-0 flex-col border-r border-[var(--v2-edge)] bg-[var(--v2-panel)]">
      <div className="flex items-center gap-1 border-b border-[var(--v2-edge)] px-3 py-2">
        <span className="flex-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--v2-muted)]">{TITLES[p.view]}</span>
        {p.view === "source" && <IconButton label="Open the full source control tab" title="Open the full tab" size={24} onClick={p.onOpenSource}><Maximize2 size={13} aria-hidden /></IconButton>}
      </div>
      <Body {...p} />
    </aside>
  );
}

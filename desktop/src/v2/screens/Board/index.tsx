// Board lens: lanes of cards for the active project, plus the card drawer on the right (#13989).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Card, HubClient } from "../../../shared/api/client";
import { presenceMap, usePeers } from "../../../shared/presence";
import type { ScreenProps } from "../../routes";
import { takeBoardCard, watchBoardCard } from "../../shell/boardIntent";
import { NotWired } from "../../shell/ClassicLenses";
import { CardFace, type NextStep } from "./CardFace";
import { DependenciesView, SeatView } from "./BoardViews";
import { Drawer } from "./Drawer";
import { Lanes } from "./Lanes";
import { ListView } from "./ListView";
import { NewCardSheet } from "./NewCardSheet";
import { buildBoard, countBy, isBusy, isFiltering, NO_FILTERS, seatGroups, type Filters } from "./model";
import { Toolbar, type View } from "./Toolbar";

const POLL_MS = 12_000;

/** Cards for one project, refetched on a timer and on the hub's card events (#13989). */
function useBoardCards(client: HubClient, project: string) {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    setCards(null); setError(null);
    const load = () => client.tasks(project)
      .then(t => { if (alive) { setCards(t); setError(null); } })
      .catch(e => { if (alive) setError(String(e?.message || e)); });
    loadRef.current = () => { void load(); };
    void load();
    const timer = setInterval(() => { void load(); }, POLL_MS);
    const off = client.streamEvents(ev => {
      if ((ev.project === project && ["created", "moved", "updated"].includes(ev.type)) || ev.type === "hub.reload") void load();
    });
    return () => { alive = false; clearInterval(timer); off?.(); };
  }, [client, project]);
  // A card moved from the drawer refetches in place; resetting to null would unmount the drawer.
  const reload = useCallback(() => loadRef.current(), []);
  const created = useCallback((card: Card) => {
    setCards(current => [...(current ?? []).filter(c => c.id !== card.id), card]);
  }, []);
  return { cards, error, reload, created };
}

export function BoardScreen({ client, project, onNavigate }: ScreenProps) {
  const [view, setView] = useState<View>("lanes");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [open, setOpen] = useState<number | null>(null);
  const [newCard, setNewCard] = useState(false);
  const { cards, error, reload, created } = useBoardCards(client, project);
  const { peers } = usePeers(client);
  const presence = useMemo(() => presenceMap(peers), [peers]);
  const projectPeers = useMemo(() => (peers ?? []).filter(p => !p.project || p.project === project), [peers, project]);
  useEffect(() => { setOpen(null); setNewCard(false); setFilters(NO_FILTERS); }, [project]);
  // #14495: a palette card opens with its drawer — taken on mount, or at once when the board is
  // already showing this project.
  const openFocused = useCallback(() => {
    const id = takeBoardCard(project);
    if (id !== null) setOpen(id);
  }, [project]);
  useEffect(() => {
    openFocused();
    return watchBoardCard(project, openFocused);
  }, [openFocused]);
  const all = cards ?? [];
  const model = useMemo(() => buildBoard(all, filters, presence), [cards, filters, presence]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => countBy(all, presence), [cards, presence]); // eslint-disable-line react-hooks/exhaustive-deps
  const filtering = isFiltering(filters);

  if (!project) return <NotWired title="Board" line="Pin a project to see its cards." />;
  if (error && !cards) return <NotWired title="Board" line={`Board unavailable: ${error}`} />;
  if (!cards) return <NotWired title="Board" line={`Loading ${project}…`} />;

  const nextStep = (c: Card): NextStep | undefined => {
    const watch: NextStep = { label: "Watch", title: "Open the workspace to watch the seat work", run: () => onNavigate("workspace") };
    if (c.status === "todo") return { label: "Open", title: "Open the card to see who it is filed for", run: () => setOpen(c.id) };
    if (c.status === "doing") return watch;
    if (c.status === "testing") return isBusy(c, presence) ? watch : { label: "Run drill", title: "Open the card: its drill line and acceptance items", run: () => setOpen(c.id) };
    return undefined;
  };
  const renderCard = (c: Card) => {
    const kids = model.nesting.childrenOf.get(c.id);
    const shownKids = filtering && kids ? kids.filter(k => buildBoard([k], filters, presence).shown > 0) : kids;
    return <CardFace key={c.id} card={c} presence={c.assignee ? presence.get(c.assignee) : undefined} selected={open === c.id}
      next={nextStep(c)} subagents={shownKids} forceOpenSubagents={filtering && !!shownKids?.length} onOpen={setOpen} />;
  };
  const flat = [model.todo, model.doing, model.testing, model.done, model.failed, model.blocked, model.stale].flatMap(l => [...l.cards, ...l.subagents]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar view={view} onView={setView} filters={filters} onFilters={setFilters} seats={seatGroups(all, presence)} counts={counts} onNewCard={() => setNewCard(true)} />
      <div className="px-5 pb-2 text-v2-body text-[var(--v2-muted)]">
        {all.length === 0 ? "No cards on this board yet." : `${all.filter(c => c.status === "done").length} of ${all.length} done${filtering ? ` · showing ${model.shown}` : ""}`}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {view === "lanes" && <Lanes model={model} filtering={filtering} renderCard={renderCard} onOpen={setOpen} />}
          {view === "list" && <ListView cards={flat} presence={presence} selected={open} onOpen={setOpen} />}
          {view === "dependencies" && <DependenciesView cards={flat} onOpen={setOpen} />}
          {view === "seat" && <SeatView cards={flat} renderCard={renderCard} />}
        </div>
        {open !== null && <Drawer client={client} id={open} onClose={() => setOpen(null)} onOpen={setOpen} onMoved={reload} escapeCloses={!newCard} />}
      </div>
      {newCard && <NewCardSheet client={client} project={project} peers={projectPeers} onClose={() => setNewCard(false)}
        onCreated={card => { created(card); setNewCard(false); setView("lanes"); }} />}
    </div>
  );
}

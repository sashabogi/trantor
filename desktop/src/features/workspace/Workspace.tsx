// The WORKSPACE lens — the one-surface view (mockup: artifact 3d6dbb67). The three surfaces
// collapse here: seats across the top, the seat's terminal in the center, the record on the right.
//
// HONESTY RULE (design system: no fake affordances): everything rendered is REAL hub data — peers,
// cards, events. Anything without a live data source ships as a stated placeholder, not imitations.
import { useEffect, useMemo, useState } from "react";
import type { Card, HubClient, HubEvent, Peer } from "../../shared/api/client";
import { ProjectHeader, type Lens } from "../project/ProjectHeader";
import { TerminalPane } from "./TerminalPane";
import { orchestratorOf, type HerdrSeat } from "./herdr";
import { SeatTab } from "./SeatTab";
import { BrandGlyph } from "../../shared/Avatar";
import { PaneBoundary } from "./PaneBoundary";
import { paneTargets, seatName, type PaneTarget } from "./paneTargets";
import { newestTerminal, projectSessions, takeoverAction, type ProjectSessions } from "../chat/takeover";
import { TakeoverStrip } from "../chat/TakeoverStrip";
import { when } from "../../shared/time";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { loadRailOpen, saveRailOpen } from "./prefs";

// A seat = a crew peer of this project (agent:project). Host sessions (MacBook-*:project) are
// the human's own windows — real peers, but not seats you'd open a terminal on, and per #5367's
// screenshot refinement the agents ARE the tabs: the host leaves the tab row and comes back as
// a small "you" chip at its right end.
function seatsOf(peers: Peer[], project: string): Peer[] {
  return peers
    .filter(p => p.session.endsWith(`:${project}`))
    .filter(p => !p.session.toLowerCase().startsWith("macbook"));
}

function hostOf(peers: Peer[], project: string): Peer | undefined {
  return peers.find(p => p.session.endsWith(`:${project}`) && p.session.toLowerCase().startsWith("macbook"));
}

function SeatDot({ online }: { online: boolean }) {
  return <span className={`tr-dot ${online ? "bg-tr-doing" : "bg-tr-muted/50"}`} />;
}

// One row in the pane strip. The crew's seats and the operator's own orchestrator pane are both
// just panes you can open, so they share a shape here — the difference is that the orchestrator is
// the person's session, which is why it leads the row and says so.
// Watching a crew and driving one seat are different jobs, and tabs only serve the second. cmux
// and herdr both showed every seat at once; replacing that with clicking made supervision worse.
// FOCUS stays the default (one seat, full size); GRID is the opt-in that puts them side by side.
type PaneView = "focus" | "grid";
const VIEW_KEY = "trantor.workspace.view";

// Same ceil(sqrt(n)) tiling crew.sh uses for real panes, so the app and the multiplexer agree on
// what a crew of N looks like.
export const gridCols = (n: number) => { let c = 1; while (c * c < n) c += 1; return c; };

// The pane area's empty state, honest by inventory (#5479). "No crew — trantor up" was a lie by
// omission while the operator's own conversation ran in a Terminal; when the inventory sees one,
// this says what IS true — the terminal cannot be mirrored (macOS will not hand one process
// another's pty), but the conversation can be read in Chat and taken over, right here. Polls
// only while shown: this card exists precisely when nothing else is rendering.
function PaneEmptyState({ project }: { project: string }) {
  const [inventory, setInventory] = useState<ProjectSessions | null>(null);
  useEffect(() => {
    let alive = true;
    const look = () => projectSessions(project).then(s => { if (alive) setInventory(s); }).catch(() => {});
    look();
    const iv = setInterval(look, 5_000);
    return () => { alive = false; clearInterval(iv); };
  }, [project]);
  const term = newestTerminal(inventory);
  const action = takeoverAction(inventory);
  if (!term || !action) {
    // No Terminal conversation (or nothing readable yet): the stated placeholder stays, word
    // for word — this surface never pretends a crew where none is.
    return (
      <div className="tr-card-ghost max-w-[440px] px-6 py-5 text-center text-[12.5px] leading-relaxed">
        No crew on this project yet. Fire one up with <span className="tr-mono">trantor up</span>
        &nbsp;and each seat&rsquo;s live terminal renders right here.
      </div>
    );
  }
  const pid = term.pid !== null ? `pid ${term.pid}` : "no pid";
  const age = term.activeAgoSec !== null ? `last active ${term.activeAgoSec}s ago` : "quiet for over an hour";
  return (
    <div className="tr-card-ghost max-w-[440px] px-6 py-5 text-center text-[12.5px] leading-relaxed">
      This conversation is running in a Terminal window ({pid}, {age}). The terminal itself cannot
      be mirrored here — but the conversation can: read it in Chat, or take it over.
      <div className="mt-3">
        <TakeoverStrip project={project} action={action} bare />
      </div>
    </div>
  );
}

export function Workspace({ client, project, lens, onLens }: {
  client: HubClient; project: string; lens: Lens; onLens: (l: Lens) => void;
}) {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [tasks, setTasks] = useState<Card[]>([]);
  // The record rail folds (#5593, operator: "it reads as a log, not a live surface") —
  // persisted, and collapsing always leaves a visible edge control to bring it back
  // (#5521 doctrine: never a dismissal that needs prior knowledge to undo).
  const [railOpen, setRailOpen] = useState(loadRailOpen);
  const toggleRail = () => setRailOpen(o => { saveRailOpen(!o); return !o; });
  const [events, setEvents] = useState<HubEvent[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [view, setView] = useState<PaneView>(() => (localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "focus"));
  const setViewPersisted = (v: PaneView) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ } };

  useEffect(() => {
    let alive = true;
    const load = () => {
      client.peers().then(p => { if (alive) setPeers(p); }).catch(() => {});
      client.tasks(project).then(t => { if (alive) setTasks(t); }).catch(() => {});
      client.events({ project, limit: 30 }).then(r => { if (alive) setEvents((r.events ?? []).slice().reverse()); }).catch(() => {});
    };
    load();
    const iv = setInterval(load, 12_000);
    return () => { alive = false; clearInterval(iv); };
  }, [client, project]);

  const seats = useMemo(() => seatsOf(peers, project), [peers, project]);
  const host = useMemo(() => hostOf(peers, project), [peers, project]);

  // Is this project's own session hosted as a pane? `trantor open` records it, and until it does
  // the host stays the quiet "you" chip it has always been.
  const [orch, setOrch] = useState<HerdrSeat | null>(null);
  useEffect(() => {
    let alive = true;
    const look = () => { orchestratorOf(project).then(o => { if (alive) setOrch(o); }).catch(() => {}); };
    look();
    const iv = setInterval(look, 12_000);
    return () => { alive = false; clearInterval(iv); };
  }, [project]);

  // The row as data lives in paneTargets.ts: pane name (terminal key) and brand are two fields.
  const targets = useMemo<PaneTarget[]>(() => paneTargets(seats, orch, host, project), [seats, orch, host, project]);

  const selected = targets.find(t => t.key === sel) ?? targets[0];
  const inFlight = useMemo(
    () => tasks.filter(t => t.status === "doing" || t.status === "testing"),
    [tasks],
  );
  // The selected seat's card, if it owns one — the record rail leads with it.
  const seatCard = selected ? inFlight.find(t => t.assignee === selected.session) ?? inFlight[0] : inFlight[0];

  const liveCount = seats.filter(s => s.online).length;
  const sub = `${liveCount} seat${liveCount === 1 ? "" : "s"} live · ${inFlight.length} card${inFlight.length === 1 ? "" : "s"} in flight`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ProjectHeader project={project} sub={sub} lens={lens} onLens={onLens} />
      <div className="flex min-h-0 flex-1 gap-4 px-8 pb-6">

        {/* center: the seat */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* seat tabs */}
          <div className="flex items-center gap-1">
            {targets.length === 0 && (
              <div className="tr-card-ghost px-4 py-2 text-[12.5px]">
                Nothing is live here — <span className="font-semibold text-tr-ok">Wake</span> the project
                from the sidebar, or fire up seats with <span className="tr-mono">trantor up</span>
              </div>
            )}
            {targets.map(t => (
              <SeatTab
                key={t.key}
                name={t.label}
                brandName={t.brand}
                status={t.status}
                active={selected?.key === t.key}
                onClick={() => { setSel(t.key); if (t.isOrchestrator) setViewPersisted("focus"); }}
                you={t.isOrchestrator}
              />
            ))}
            {/* no hosted orchestrator pane yet: the host stays a quiet chip at the row's end */}
            {host && !orch && (
              <span className="ml-auto flex items-center gap-2 rounded-[9px] px-3 py-[7px] text-[12px] text-tr-muted">
                <BrandGlyph name={host.session} size={12} />
                you
              </span>
            )}
            {seats.length > 1 && (
              <div className={`${host && !orch ? "" : "ml-auto"} flex items-center gap-1 rounded-[9px] bg-tr-panel/60 p-[3px]`}>
                {(["focus", "grid"] as const).map(v => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setViewPersisted(v)}
                    data-on={view === v}
                    title={v === "grid" ? "every seat at once" : "one seat, full size"}
                    className="rounded-[7px] px-2.5 py-[5px] text-[11.5px] font-medium text-tr-muted data-[on=true]:bg-tr-panel data-[on=true]:text-tr-text data-[on=true]:shadow-sm"
                  >
                    {v}
                  </button>
                ))}
              </div>
            )}
          </div>

          {view === "grid" ? (
            /* GRID: the whole crew at once, read-only. The orchestrator is deliberately absent —
               it is the operator, not a seat to supervise, and it gets its own surface. */
            <div
              className="mt-2.5 grid min-h-0 flex-1 gap-2.5"
              style={{ gridTemplateColumns: `repeat(${gridCols(seats.length)}, minmax(0, 1fr))` }}
            >
              {seats.map(sp => (
                <div key={sp.session} className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-tr-edge bg-[#101013] p-2.5">
                  <button
                    type="button"
                    onClick={() => { setSel(sp.session); setViewPersisted("focus"); }}
                    title="open this seat full size"
                    className="mb-1.5 flex items-center gap-2 text-left"
                  >
                    <SeatDot online={!!sp.online} />
                    <span className="tr-mono text-[11.5px] text-tr-text">{seatName(sp.session)}</span>
                    {sp.status && <span className="truncate text-[11px] text-tr-muted">{sp.status}</span>}
                  </button>
                  <div className="flex min-h-0 flex-1 flex-col">
                    <PaneBoundary key={sp.session}>
                      <TerminalPane project={project} agent={seatName(sp.session)} />
                    </PaneBoundary>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <>
          {/* seat bar — the seat's REAL identity and status; branch/diffstat joins when P0-A lands */}
            {selected && (
              <div className="tr-card mt-2.5 flex items-center gap-3 px-3.5 py-2">
                <span className="tr-mono text-[12px] text-tr-muted">{selected.session}</span>
                <span className="tr-chip">{selected.online ? "online" : selected.lastSeen ? `last seen ${when(selected.lastSeen)}` : "never seen"}</span>
                {selected.status && <span className="max-w-[340px] truncate text-[12px] text-tr-muted">{selected.status}</span>}
              </div>
            )}

            {/* terminal pane — the seat's live herdr pane when one exists (#5367); the stated
                placeholder stays the no-surface fallback, word for word */}
            <div className="mt-2.5 flex min-h-0 flex-1 flex-col rounded-xl border border-tr-edge bg-[#101013] p-4">
              <div className="tr-mono text-[12px] leading-[1.75] text-tr-muted">
                {selected ? `${selected.session} — live terminal` : "live terminal"}
              </div>
              {selected ? (
              <PaneBoundary key={selected.key}>
                <TerminalPane project={project} agent={selected.agent} />
              </PaneBoundary>
            ) : (
              <div className="flex flex-1 items-center justify-center">
                <PaneEmptyState project={project} />
              </div>
              )}
              </div>
            </>
          )}
        </div>

        {/* right: the record rail — collapsible (#5593): a log earns its space on demand,
            not by default. Folded, it survives as a slim edge control that names itself. */}
        {!railOpen && (
          <button type="button" onClick={toggleRail} title="Show the record rail"
            className="flex w-7 shrink-0 flex-col items-center gap-2 rounded-xl border border-tr-edge bg-[#101013] py-3 text-tr-muted hover:text-[var(--color-tr-text)]">
            <PanelRightOpen size={14} strokeWidth={1.75} />
            <span className="text-[10px] font-medium uppercase tracking-widest" style={{ writingMode: "vertical-rl" }}>
              Record
            </span>
          </button>
        )}
        {railOpen && (
        <div className="flex w-[296px] shrink-0 flex-col gap-3 overflow-hidden">
          {seatCard ? (
            <div className="tr-card px-4 py-3.5">
              <div className="flex items-center gap-2">
                <span className="tr-mono text-[12px] text-tr-muted">#{seatCard.id}</span>
                <span className="tr-chip">{seatCard.status}</span>
                {/* the rail leads with the selected seat's card, but falls through to ANY card in
                    flight — when this one belongs to someone else, say whose it is (#5367) */}
                {seatCard.assignee && seatCard.assignee !== selected?.session && (
                  <span className="tr-chip">{seatName(seatCard.assignee)}'s card</span>
                )}
                {seatCard.difficulty && <span className="tr-chip ml-auto">{seatCard.difficulty}</span>}
              </div>
              <div className="mt-2 text-[13.5px] font-medium leading-snug">{seatCard.title}</div>
              <div className="mt-2.5 text-[11.5px] text-tr-muted">
                {seatCard.assignee ?? "unassigned"}{seatCard.log?.length ? ` · ${seatCard.log.length} log notes` : ""}
              </div>
            </div>
          ) : (
            <div className="tr-card-ghost px-4 py-3.5 text-[12.5px]">Nothing in flight on this board</div>
          )}

          <div className="tr-card flex min-h-0 flex-1 flex-col px-4 py-3.5">
            <div className="flex items-center justify-between">
              <div className="text-[13px] font-semibold">Record</div>
              <button type="button" onClick={toggleRail} title="Collapse the record rail — the edge control brings it back"
                className="text-tr-muted hover:text-[var(--color-tr-text)]">
                <PanelRightClose size={14} strokeWidth={1.75} />
              </button>
            </div>
            <div className="mt-1 min-h-0 flex-1 overflow-y-auto">
              {events.length === 0 && <div className="py-2 text-[12px] text-tr-muted">Quiet so far.</div>}
              {events.slice(0, 20).map((e, i) => (
                <div key={e.id ?? i} className="flex items-start gap-2 border-t border-tr-edge/60 py-2 text-[12px] text-tr-muted first:border-t-0">
                  <span className="min-w-0 flex-1 truncate">
                    {e.type === "message"
                      ? `${seatName(e.by ?? "?")}: ${e.text ?? ""}`
                      : `${e.type}${e.taskId ? ` #${e.taskId}` : ""}${e.title ? ` · ${e.title}` : ""}${e.by ? ` · ${seatName(e.by)}` : ""}`}
                  </span>
                  <span className="shrink-0 text-[11px] text-tr-muted/70">{e.ts ? when(e.ts) : ""}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

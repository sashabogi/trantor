// The WORKSPACE lens — the one-surface view (mockup: artifact 3d6dbb67). The three surfaces
// collapse here: seats across the top, the seat's terminal in the center, the record on the right.
//
// HONESTY RULE (design system: no fake affordances): everything rendered is REAL hub data — peers,
// cards, events. The two things whose data sources land in P0-A/P0-B ship as stated placeholders,
// not imitations: the terminal pane says plainly that the live pane arrives with the herdr wiring,
// and the composer is disabled with the phase that enables it named on the control itself.
import { useEffect, useMemo, useState } from "react";
import type { Card, HubClient, HubEvent, Peer } from "../../shared/api/client";
import { ProjectHeader, type Lens } from "../project/ProjectHeader";
import { TerminalPane } from "./TerminalPane";
import { when } from "../../shared/time";

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

const seatName = (session: string) => session.split(":")[0];

function SeatDot({ p }: { p: Peer }) {
  const cls = p.online ? "bg-tr-doing" : "bg-tr-muted/50";
  return <span className={`tr-dot ${cls}`} />;
}

export function Workspace({ client, project, lens, onLens }: {
  client: HubClient; project: string; lens: Lens; onLens: (l: Lens) => void;
}) {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [tasks, setTasks] = useState<Card[]>([]);
  const [events, setEvents] = useState<HubEvent[]>([]);
  const [sel, setSel] = useState<string | null>(null);

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
  const selected = seats.find(s => s.session === sel) ?? seats[0];
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
            {seats.length === 0 && (
              <div className="tr-card-ghost px-4 py-2 text-[12.5px]">
                No seats on this project — fire some up with <span className="tr-mono">trantor up</span>
              </div>
            )}
            {seats.map(s => (
              <button
                key={s.session}
                onClick={() => setSel(s.session)}
                data-on={selected?.session === s.session}
                className="flex items-center gap-2 rounded-[9px] px-3 py-[7px] text-[12.5px] font-medium text-tr-muted data-[on=true]:bg-tr-panel data-[on=true]:text-tr-text data-[on=true]:shadow-sm"
              >
                <SeatDot p={s} />
                {seatName(s.session)}
              </button>
            ))}
            {/* the host's own session is not a seat — a quiet "you" chip at the row's end */}
            {host && (
              <span className="ml-auto flex items-center gap-2 rounded-[9px] px-3 py-[7px] text-[12px] text-tr-muted">
                <SeatDot p={host} />
                you
              </span>
            )}
          </div>

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
              <TerminalPane
                project={project}
                agent={seatName(selected.session)}
                fallback={
                  <div className="flex flex-1 items-center justify-center">
                    <div className="tr-card-ghost max-w-[420px] px-6 py-5 text-center text-[12.5px] leading-relaxed">
                      The live pane renders here once the herdr backend lands (P0-B).
                      Until then this seat is visible in cmux, and everything it does is in the record →
                    </div>
                  </div>
                }
              />
            ) : (
              <div className="flex flex-1 items-center justify-center">
                <div className="tr-card-ghost max-w-[420px] px-6 py-5 text-center text-[12.5px] leading-relaxed">
                  The live pane renders here once the herdr backend lands (P0-B).
                  Until then this seat is visible in cmux, and everything it does is in the record →
                </div>
              </div>
            )}
          </div>

          {/* composer — present, honest about when it turns on */}
          <div className="tr-card mt-2.5 flex items-center gap-2.5 px-3.5 py-2.5 opacity-70">
            <span className="tr-mono text-[13px] text-tr-ok">›</span>
            <span className="text-[13px] text-tr-muted">Typing into a seat lands in Phase 2 — messages ride the bus until then</span>
          </div>
        </div>

        {/* right: the record rail */}
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
            <div className="text-[13px] font-semibold">Record</div>
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
      </div>
    </div>
  );
}

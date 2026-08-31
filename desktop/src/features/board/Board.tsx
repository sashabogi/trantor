// BOARD — one of the two lenses (the other is FEED). Lanes of cards for a single project.
//
// Deliberately NOT a port of Buzz's UI: theirs is channels/messages/threads, ours is lanes/cards.
// What we take from them is the SHELL (sidebar + main), which is layout rather than code — so no
// Apache-2.0 obligations land on an MIT repo. Colours are Trantor's own: the same hex values
// bin/crew-runner.mjs already pushes into the cmux sidebar, so a seat that is "building" in the
// terminal is the same blue here.
import { useEffect, useMemo, useState } from "react";
import type { Card, HubClient } from "../../shared/api/client";
import { CardDetail } from "./CardDetail";
import { SubagentGroup } from "./SubagentGroup";
import { ProjectHeader, type Lens } from "../project/ProjectHeader";
import { AgentChip, Avatar, cleanTitle, displayName } from "../../shared/Avatar";
import { usePeers, presenceMap, stateOf, PRESENCE_COLOR, type PresenceState } from "../../shared/presence";
import { dictGet } from "../../shared/dict";
import { matchesCard } from "../search/match";

// Lane order matches the hub's own card flow: todo -> doing -> testing -> done, with the two
// exception lanes last. `stale` comes from the reaper, `blocked` is set by hand.
const LANES = ["todo", "doing", "testing", "done", "failed", "blocked", "stale"] as const;
type LaneName = (typeof LANES)[number];

const LANE_COLOR = {
  todo: "var(--color-tr-muted)",
  doing: "var(--color-tr-doing)",
  testing: "var(--color-tr-warn)",
  done: "var(--color-tr-ok)",
  failed: "var(--color-tr-fail)",
  blocked: "var(--color-tr-fail)",
  stale: "var(--color-tr-muted)",
} as const satisfies Record<LaneName, string>;

// The hub's own card flow. NEVER jump straight to done: `testing` is a real gate, and the whole
// crew protocol depends on it (bin/crew.sh bounces anything that skips it), so the client must not
// offer a shortcut the protocol forbids. Keyed by a card's live `status`, which is not a closed
// type client-side — a hub-side status this build has never seen must fall through to "no move",
// not a type error, so lookups go through `dictGet` rather than indexing directly.
const NEXT = { todo: "doing", doing: "testing", testing: "done" } as const satisfies Record<string, string>;


// Sub-agents nest under the session that spawned them, and the join is `subagent.parent === focus.cc`.
//
// That took a data change to make possible. `parent` has always been a Claude Code session UUID,
// while a focus card's `assignee` is a BUS session id ("MacBook-Pro-M1:trantor") — different
// namespaces, so joining on it resolved 0 of 431 live cards. And a bus id is per (host, project),
// so ALL 28 of crebral-health's focus cards shared one: joining on THAT piled every sub-agent the
// machine ever ran onto whichever tile rendered last ("2157 sub-agents · $9068.89"). Focus cards
// now carry `cc`, the Claude session UUID, which is exactly the key `parent` already spoke.
//
// Two things stay true and the fallback keeps honouring them: the hub COLLAPSES repeat runs into
// one rolling card (counts reach 739), so a card can genuinely span many sessions; and a card
// written before 0.17.70 has no `cc` to join to. Anything that does not resolve to a focus card in
// this project keeps the LANE roll-up — one quiet line per lane, claiming only what is true.
type Lane = { cards: Card[]; subagents: Card[]; openSubagents: boolean };

/** focus card (by cc) ← its sub-agent children, plus the ids that are now rendered as children. */
type Nesting = { childrenOf: Map<number, Card[]>; nested: Set<number> };

function buildNesting(cards: Card[]): Nesting {
  const focusByCc = new Map<string, Card>();
  for (const c of cards) if (c.source === "session" && c.cc) focusByCc.set(c.cc, c);
  const childrenOf = new Map<number, Card[]>();
  const nested = new Set<number>();
  for (const c of cards) {
    if (c.source !== "cc-subagent" || !c.parent) continue;
    const parent = focusByCc.get(c.parent);
    if (!parent) continue;                       // unresolvable → the lane roll-up still has it
    const kids = childrenOf.get(parent.id);
    kids ? kids.push(c) : childrenOf.set(parent.id, [c]);
    nested.add(c.id);
  }
  for (const kids of childrenOf.values()) kids.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  return { childrenOf, nested };
}

function passesAssignee(card: Card, assignee: string): boolean {
  return !assignee || card.assignee === assignee;
}

const isSubagent = (c: Card) => c.source === "cc-subagent";

/** Split one lane's cards into real work and the sub-agent roll-up that sits under it.
 *
 * A sub-agent card matched by an ACTIVE search is never hidden inside a collapsed group — the
 * group opens instead. Searching for something and having it silently swallowed by a collapsed
 * summary is the one behaviour a board cannot have. */
function splitLane(cards: Card[], query: string, assignee: string, nesting: Nesting): Lane {
  const searching = query.trim() !== "" || assignee !== "";
  const hit = (c: Card) => matchesCard(c, query) && passesAssignee(c, assignee);
  const visible = cards.filter(c => {
    if (nesting.nested.has(c.id)) return false;      // it renders under its parent, never as a sibling
    if (hit(c)) return true;
    // A parent stays on the board when the thing you searched for is one of its children —
    // otherwise the match would vanish with the tile that holds it.
    return !!nesting.childrenOf.get(c.id)?.some(hit);
  });
  const work = visible.filter(c => !isSubagent(c));
  const subagents = visible.filter(isSubagent);
  return { cards: work, subagents, openSubagents: searching && subagents.length > 0 };
}

/** #5609 — what a card's face says about life, decided ONCE. Both active lanes wear liveness:
 *  doing AND testing breathe while their assignee is mid-turn (verification is work too), a
 *  doing card with a dead assignee says so, and a testing card whose assignee went quiet is
 *  waiting on the OPERATOR — the card says "awaiting verdict" instead of sitting there looking
 *  dead (the operator asked "why do these testing cards say nothing" twice on 2026-08-30). */
/** #5609 follow-up — the card's own pace, from the two truths it carries: when it was last
 *  touched (`updated`, which log notes bump) and how deep its story runs (`log.length`). This
 *  is what separates five identically-pulsing cards: "last activity 30s ago" is being driven,
 *  "2h ago" is parked. Deliberately NOT a percentage: progress needs a denominator, open-ended
 *  agent work has none, and the board never asserts knowledge it does not have. */
export function cardPace(card: { updated?: number; ts?: number; log?: { ts: number }[] }, now = Date.now()): string | null {
  const logs = card.log ?? [];
  const lastLog = logs.length ? logs[logs.length - 1].ts : 0;
  const touched = Math.max(card.updated ?? 0, card.ts ?? 0, lastLog);
  if (!touched) return null;
  const s = Math.max(0, Math.round((now - touched) / 1000));
  const agoTxt = s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  const notes = logs.length ? ` · ${logs.length} note${logs.length === 1 ? "" : "s"}` : "";
  return `last activity ${agoTxt} ago${notes}`;
}

export function cardLiveness(status: string, presence?: PresenceState) {
  const activeLane = status === "doing" || status === "testing";
  return {
    inMotion: activeLane && presence === "busy",
    alarmed: status === "failed" || status === "blocked",
    stalled: status === "doing" && (!presence || presence === "offline"),
    awaitingVerdict: status === "testing" && presence !== "busy",
  };
}

function CardTile({ card, onOpen, onAdvance, presence, subagents, subagentsOpen }: {
  card: Card; onOpen: (c: Card) => void; onAdvance?: (c: Card) => void; presence?: PresenceState;
  /** sub-agents this session spawned — rendered INSIDE the tile, so the tree reads as one thing */
  subagents?: Card[]; subagentsOpen?: boolean;
}) {
  const next = dictGet(NEXT, card.status);
  // A card is only believably IN MOTION when its assignee's heartbeat is fresh — "doing" with a
  // dead assignee is exactly the stall the operator needs to spot. Live work breathes (ring +
  // pulsing dot); failed/blocked pulse red like the old web UI did; a doing-card whose assignee
  // is offline says so instead of pretending.
  const { inMotion, alarmed, stalled, awaitingVerdict } = cardLiveness(card.status, presence);
  const pace = (card.status === "doing" || card.status === "testing") ? cardPace(card) : null;
  // TODO ROT (CARDLOG contract): a todo card untouched >7d wears its age — quiet between 7 and
  // 14 days, warn-colored from 14. Untouched = now - (updated || ts), the same clock the hub's
  // own todo reaper reads, so the badge and the "stale" lane can never disagree about age.
  const ageDays = Math.floor((Date.now() - (card.updated || card.ts || 0)) / 864e5);
  const agedTodo = card.status === "todo" && ageDays > 7;
  return (
    // Click opens the drawer. The first cut advanced the card on click — a misclick MOVED a card,
    // which is exactly the kind of surprise a shared board cannot afford. Advancing is now the
    // explicit → button, here and in the drawer.
    <div
      onClick={() => onOpen(card)}
      className={`tr-card tr-card-hover min-w-0 shrink-0 cursor-pointer overflow-hidden p-3.5 text-[13px] ${inMotion ? "tr-card-live" : ""} ${alarmed ? "tr-card-alarm" : ""}`}
      // #5525: the card wears its status on its left edge — meaning, not decoration. Muted lanes
      // (todo/stale) get the muted token, so quiet stays quiet and the scale stays one system.
      style={{ borderLeft: `2px solid color-mix(in srgb, ${dictGet(LANE_COLOR, card.status) ?? "var(--color-tr-edge)"} 55%, transparent)` }}>
      <div className="leading-snug break-words [overflow-wrap:anywhere]">{card.summary || cleanTitle(card.title)}</div>
      {pace && (
        <div className="tr-mono mt-1.5 truncate text-[10px] text-[var(--color-tr-muted)]/80" title="when this card was last touched — driven vs parked">
          {pace}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-tr-muted)]">
        {inMotion && <span className="tr-dot tr-dot-pulse shrink-0" style={{ background: card.status === "testing" ? "var(--color-tr-warn)" : "var(--color-tr-doing)" }} title="assignee is mid-turn right now" />}
        {stalled && <span className="shrink-0 rounded bg-black/30 px-1.5 py-0.5 text-[var(--color-tr-warn)]" title="doing, but the assignee has no heartbeat">assignee offline</span>}
        {awaitingVerdict && (
          <span className="shrink-0 rounded bg-black/30 px-1.5 py-0.5 text-[var(--color-tr-warn)]"
                title="verification finished — this card moves when the operator accepts or bounces it">
            awaiting verdict
          </span>
        )}
        {(card.workedBy || card.assignee) && <AgentChip session={card.workedBy || card.assignee!} />}
        {card.difficulty && <span className="rounded bg-black/30 px-1.5 py-0.5">{card.difficulty[0].toUpperCase()}</span>}
        {card.model && <span className="tr-mono max-w-[150px] truncate rounded bg-black/30 px-1.5 py-0.5">{card.model}</span>}
        {/* #5624: the acceptance denominator — rendered ONLY when a checklist exists; a card
            without one shows nothing rather than a fabricated bar. */}
        {card.checklist && card.checklist.length > 0 && (
          <span className="flex shrink-0 items-center gap-1 rounded bg-black/30 px-1.5 py-0.5"
                title={`${card.checklist.filter(c => c.done).length} of ${card.checklist.length} acceptance items met`}>
            {card.checklist.filter(c => c.done).length}/{card.checklist.length}
            <span className="h-[3px] w-8 overflow-hidden rounded-full bg-white/10">
              <span className="block h-full rounded-full bg-[var(--color-tr-doing)]"
                    style={{ width: `${(card.checklist.filter(c => c.done).length / card.checklist.length) * 100}%` }} />
            </span>
          </span>
        )}
        {agedTodo && (
          <span className={`shrink-0 rounded bg-black/30 px-1.5 py-0.5 ${ageDays >= 14 ? "text-[var(--color-tr-warn)]" : "text-[var(--color-tr-muted)]"}`}
                title={`todo, untouched for ${ageDays}d`}>{ageDays}d</span>
        )}
        <span className="tr-mono ml-auto opacity-60">#{card.id}</span>
        {next && (
          <button
            title={`move to ${next}`}
            onClick={e => { e.stopPropagation(); onAdvance?.(card); }}
            className="rounded border border-[var(--color-tr-edge)] px-1.5 py-0.5 hover:border-[var(--color-tr-doing)] hover:text-[var(--color-tr-text)]">
            →
          </button>
        )}
      </div>
      {subagents && subagents.length > 0 && (
        // Inside the tile, not beside it: a sub-agent belongs to this session's story, and a
        // sibling tile is exactly the flat shape that buried real work in the first place.
        <div onClick={e => e.stopPropagation()}>
          <SubagentGroup items={subagents} forceOpen={!!subagentsOpen} variant="nested" onOpen={onOpen} />
        </div>
      )}
    </div>
  );
}

export function Board({ client, project, lens, onLens, focusCard, onFocusConsumed }: {
  client: HubClient; project: string; lens: Lens; onLens: (l: Lens) => void;
  /** a card the palette chose (#5625): opened once on arrival, then handed back */
  focusCard?: number | null; onFocusConsumed?: () => void;
}) {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [assignee, setAssignee] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  // The palette's pick (#5625): arrive on the board with the drawer already open.
  useEffect(() => {
    if (focusCard != null) { setOpen(focusCard); onFocusConsumed?.(); }
  }, [focusCard, onFocusConsumed]);
  const { peers } = usePeers(client);
  const presence = useMemo(() => presenceMap(peers), [peers]);
  // Who is HERE, alive, right now — surfaced in the header so a project screen never again reads
  // as a dead list. Busy sessions breathe; idle ones sit still; offline ones don't appear.
  const liveHere = useMemo(
    () => (peers ?? []).filter(p => p.project === project && stateOf(p) !== "offline")
      .sort((a, b) => (stateOf(a) === "busy" ? 0 : 1) - (stateOf(b) === "busy" ? 0 : 1)),
    [peers, project],
  );

  useEffect(() => {
    let alive = true;
    setCards(null); setError(null); setOpen(null); setQuery(""); setAssignee("");
    client.tasks(project)
      .then(t => { if (alive) setCards(t); })
      .catch(e => { if (alive) setError(String(e.message || e)); });
    return () => { alive = false; };
  }, [client, project]);

  // Live updates ride the SAME stream the FEED uses. A card event is cheap to react to: refetch the
  // project rather than trying to replay hub-side card mutation logic in the client, which is exactly
  // the kind of duplicated state machine that drifts. `hub.reload` means the hub swapped its whole
  // in-memory state after an external write — refetch then too.
  useEffect(() => {
    return client.streamEvents(ev => {
      if ((ev.project === project && ["created", "moved", "updated"].includes(ev.type)) || ev.type === "hub.reload") {
        client.tasks(project).then(setCards).catch(() => {});
      }
    });
  }, [client, project]);

  // Optimistic, with rollback. The stream will confirm it a beat later; showing the move immediately
  // is the difference between a tool and a dashboard.
  const advance = (card: Card) => {
    const next = dictGet(NEXT, card.status);
    if (!next || !cards) return;
    const before = cards;
    setCards(cards.map(c => (c.id === card.id ? { ...c, status: next } : c)));
    client.moveCard(card.id, next).catch(() => setCards(before));
  };

  const assignees = useMemo(
    () => [...new Set((cards ?? []).map(c => c.assignee).filter((a): a is string => !!a))].sort(),
    [cards],
  );
  // Exception lanes earn their width by having cards in them; the four flow lanes are always the
  // board's shape. Seven permanent columns forced a horizontal scroll that clipped lane counts.
  const nesting = useMemo(() => buildNesting(cards ?? []), [cards]);
  const byLane = useMemo(() => {
    const all = cards ?? [];
    return LANES
      .map(l => [l, splitLane(all.filter(c => (c.status || "todo") === l), query, assignee, nesting)] as const)
      .filter(([l, lane]) => !["failed", "blocked", "stale"].includes(l) || lane.cards.length + lane.subagents.length > 0);
  }, [cards, query, assignee, nesting]);

  if (error) return <div className="p-6 text-sm text-[var(--color-tr-fail)]">Board unavailable: {error}</div>;
  if (!cards) return <div className="p-6 text-sm text-[var(--color-tr-muted)]">Loading {project}…</div>;

  const done = cards.filter(c => c.status === "done").length;
  const filtered = query.trim() !== "" || assignee !== "";
  const shown = byLane.reduce((n, [, lane]) => n + lane.cards.length + lane.subagents.length, 0);

  return (
    <div className="tr-pane relative flex h-full flex-col">
      <ProjectHeader project={project} lens={lens} onLens={onLens}
        sub={<span className="flex items-center gap-x-2">
          <span>{done}/{cards.length} done · {Math.round((done / Math.max(cards.length, 1)) * 100)}%{filtered && <> · showing {shown}</>}</span>
          {liveHere.length > 0 && <span className="flex items-center gap-1.5">
            <span className="opacity-60">·</span>
            {liveHere.slice(0, 8).map(p => {
              const st = stateOf(p);
              return (
                <span key={p.session} className="relative inline-flex" title={`${displayName(p.session, p.llm)} — ${st}`}>
                  <Avatar name={p.session} llm={p.llm} size={18} />
                  <span className={`tr-dot absolute -right-0.5 -bottom-0.5 ${st === "busy" ? "tr-dot-pulse" : ""}`}
                        style={{ background: PRESENCE_COLOR[st], width: 7, height: 7, border: "1.5px solid var(--color-tr-panel)" }} />
                </span>
              );
            })}
            <span className="text-[11px]">{liveHere.length} live</span>
          </span>}
        </span>}>
        {/* The assignee filter SAYS what it filters (operator, 2026-08-30: "what was your
            intention with that?" — a bare 'everyone' dropdown stranded without its old search
            sibling reads as mystery chrome; a control that needs explaining has failed). */}
        {assignees.length > 0 && (
          <label className="flex items-center gap-1.5 text-[11px] text-[var(--color-tr-muted)]" title="show only one assignee's cards">
            <span className="shrink-0">cards by</span>
            <select value={assignee} onChange={e => setAssignee(e.target.value)} className="tr-input">
              <option value="">everyone</option>
              {assignees.map(a => <option key={a} value={a}>@{a}</option>)}
            </select>
          </label>
        )}
      </ProjectHeader>
      <div className="flex flex-1 gap-4 overflow-x-auto px-8 pb-6">
        {byLane.map(([lane, { cards: work, subagents, openSubagents }]) => (
          <section key={lane} className="tr-lane flex w-[290px] shrink-0 grow-0 flex-col rounded-xl bg-white/[0.025] p-2.5">
            <div className="mb-2.5 flex items-center gap-2 px-1.5 pt-1">
              <span className="tr-dot" style={{ background: LANE_COLOR[lane] }} />
              {/* #5525: the lane label speaks its own color — the lane IS a status, so this is
                  meaning, not chrome. Muted lanes resolve to the muted token and stay quiet. */}
              <span className="tr-label" style={{ color: LANE_COLOR[lane] }}>{lane}</span>
              <span className="tr-mono ml-auto text-[11px] text-[var(--color-tr-muted)]">
                {work.length + subagents.length}
              </span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto px-0.5 pb-1">
              {/* The roll-up leads the lane. It is one collapsed line, so it cannot compete with
                  real work — and putting it last buried it under up to 200 cards (the done lane
                  holds 871), which is not a place anyone would find it. A summary goes at the top. */}
              <SubagentGroup items={subagents} forceOpen={openSubagents} onOpen={c => setOpen(c.id)} />
              {work.slice(0, 200).map(c => {
                // A search filters the nested list too, and opens it — a matched sub-agent must
                // never be swallowed by the collapsed summary that holds it.
                const kids = nesting.childrenOf.get(c.id);
                const shownKids = filtered && kids ? kids.filter(k => matchesCard(k, query) && passesAssignee(k, assignee)) : kids;
                return (
                  <CardTile key={c.id} card={c} onOpen={c2 => setOpen(c2.id)} onAdvance={advance}
                            presence={c.assignee ? presence.get(c.assignee) : undefined}
                            subagents={shownKids} subagentsOpen={filtered && !!shownKids?.length} />
                );
              })}
            </div>
          </section>
        ))}
      </div>
      {open !== null && (
        <CardDetail client={client} id={open} onClose={() => setOpen(null)} onOpen={setOpen}
                    onMoved={() => client.tasks(project).then(setCards).catch(() => {})} />
      )}
    </div>
  );
}

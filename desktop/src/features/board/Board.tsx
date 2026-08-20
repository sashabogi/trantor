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
import { ProjectHeader } from "../project/ProjectHeader";
import { AgentChip, Avatar, cleanTitle, displayName } from "../../shared/Avatar";
import { usePeers, presenceMap, stateOf, PRESENCE_COLOR, type PresenceState } from "../../shared/presence";

// Lane order matches the hub's own card flow: todo -> doing -> testing -> done, with the two
// exception lanes last. `stale` comes from the reaper, `blocked` is set by hand.
const LANES = ["todo", "doing", "testing", "done", "failed", "blocked", "stale"] as const;

const LANE_COLOR: Record<string, string> = {
  todo: "var(--color-tr-muted)",
  doing: "var(--color-tr-doing)",
  testing: "var(--color-tr-warn)",
  done: "var(--color-tr-ok)",
  failed: "var(--color-tr-fail)",
  blocked: "var(--color-tr-fail)",
  stale: "var(--color-tr-muted)",
};

// The hub's own card flow. NEVER jump straight to done: `testing` is a real gate, and the whole
// crew protocol depends on it (bin/crew.sh bounces anything that skips it), so the client must not
// offer a shortcut the protocol forbids.
const NEXT: Record<string, string> = { todo: "doing", doing: "testing", testing: "done" };

// Search understands the board's own vocabulary: plain text matches titles, `#123` a card id,
// `@name` an assignee. One box, no advanced-search modal.
function matches(card: Card, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (q.startsWith("#")) return String(card.id).startsWith(q.slice(1));
  if (q.startsWith("@")) return (card.assignee || "").toLowerCase().includes(q.slice(1));
  return card.title.toLowerCase().includes(q) || (card.assignee || "").toLowerCase().includes(q);
}

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
  const hit = (c: Card) => matches(c, query) && passesAssignee(c, assignee);
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

function CardTile({ card, onOpen, onAdvance, presence, subagents, subagentsOpen }: {
  card: Card; onOpen: (c: Card) => void; onAdvance?: (c: Card) => void; presence?: PresenceState;
  /** sub-agents this session spawned — rendered INSIDE the tile, so the tree reads as one thing */
  subagents?: Card[]; subagentsOpen?: boolean;
}) {
  const next = NEXT[card.status];
  // A card is only believably IN MOTION when its assignee's heartbeat is fresh — "doing" with a
  // dead assignee is exactly the stall the operator needs to spot. Live work breathes (ring +
  // pulsing dot); failed/blocked pulse red like the old web UI did; a doing-card whose assignee
  // is offline says so instead of pretending.
  const inMotion = card.status === "doing" && presence === "busy";
  const alarmed = card.status === "failed" || card.status === "blocked";
  const stalled = card.status === "doing" && (!presence || presence === "offline");
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
      className={`tr-card tr-card-hover min-w-0 shrink-0 cursor-pointer overflow-hidden p-3.5 text-[13px] ${inMotion ? "tr-card-live" : ""} ${alarmed ? "tr-card-alarm" : ""}`}>
      <div className="leading-snug break-words [overflow-wrap:anywhere]">{card.summary || cleanTitle(card.title)}</div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-tr-muted)]">
        {inMotion && <span className="tr-dot tr-dot-pulse shrink-0" style={{ background: "var(--color-tr-doing)" }} title="assignee is mid-turn right now" />}
        {stalled && <span className="shrink-0 rounded bg-black/30 px-1.5 py-0.5 text-[var(--color-tr-warn)]" title="doing, but the assignee has no heartbeat">assignee offline</span>}
        {card.assignee && <AgentChip session={card.assignee} />}
        {card.difficulty && <span className="rounded bg-black/30 px-1.5 py-0.5">{card.difficulty[0].toUpperCase()}</span>}
        {card.model && <span className="tr-mono max-w-[150px] truncate rounded bg-black/30 px-1.5 py-0.5">{card.model}</span>}
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

export function Board({ client, project, lens, onLens }: {
  client: HubClient; project: string; lens: string; onLens: (l: string) => void;
}) {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [assignee, setAssignee] = useState("");
  const [open, setOpen] = useState<number | null>(null);
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
    const next = NEXT[card.status];
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
        sub={<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
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
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search — text, #id, @assignee"
          className="tr-input w-56"
        />
        {assignees.length > 0 && (
          <select value={assignee} onChange={e => setAssignee(e.target.value)} className="tr-input">
            <option value="">everyone</option>
            {assignees.map(a => <option key={a} value={a}>@{a}</option>)}
          </select>
        )}
      </ProjectHeader>
      <div className="flex flex-1 gap-4 overflow-x-auto px-8 pb-6">
        {byLane.map(([lane, { cards: work, subagents, openSubagents }]) => (
          <section key={lane} className="tr-lane flex w-[290px] shrink-0 grow-0 flex-col rounded-xl bg-white/[0.025] p-2.5">
            <div className="mb-2.5 flex items-center gap-2 px-1.5 pt-1">
              <span className="tr-dot" style={{ background: LANE_COLOR[lane] }} />
              <span className="tr-label">{lane}</span>
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
                const shownKids = filtered && kids ? kids.filter(k => matches(k, query) && passesAssignee(k, assignee)) : kids;
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

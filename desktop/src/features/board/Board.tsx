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
import { ProjectHeader } from "../project/ProjectHeader";

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

function CardTile({ card, onOpen, onAdvance }: {
  card: Card; onOpen: (c: Card) => void; onAdvance?: (c: Card) => void;
}) {
  const next = NEXT[card.status];
  return (
    // Click opens the drawer. The first cut advanced the card on click — a misclick MOVED a card,
    // which is exactly the kind of surprise a shared board cannot afford. Advancing is now the
    // explicit → button, here and in the drawer.
    <div
      onClick={() => onOpen(card)}
      className="tr-card tr-card-hover cursor-pointer p-3.5 text-[13px]">
      <div className="leading-snug">{card.title}</div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-tr-muted)]">
        {card.assignee && <span className="rounded bg-black/30 px-1.5 py-0.5">@{card.assignee}</span>}
        {card.difficulty && <span className="rounded bg-black/30 px-1.5 py-0.5">{card.difficulty[0].toUpperCase()}</span>}
        {card.model && <span className="tr-mono max-w-[150px] truncate rounded bg-black/30 px-1.5 py-0.5">{card.model}</span>}
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

  if (error) return <div className="p-6 text-sm text-[var(--color-tr-fail)]">Board unavailable: {error}</div>;
  if (!cards) return <div className="p-6 text-sm text-[var(--color-tr-muted)]">Loading {project}…</div>;

  const visible = cards.filter(c => matches(c, query) && (!assignee || c.assignee === assignee));
  // Exception lanes earn their width by having cards in them; the four flow lanes are always the
  // board's shape. Seven permanent columns forced a horizontal scroll that clipped lane counts.
  const byLane = LANES.map(l => [l, visible.filter(c => (c.status || "todo") === l)] as const)
    .filter(([l, list]) => !["failed", "blocked", "stale"].includes(l) || list.length > 0);
  const done = cards.filter(c => c.status === "done").length;
  const filtered = visible.length !== cards.length;

  return (
    <div className="tr-pane relative flex h-full flex-col">
      <ProjectHeader project={project} lens={lens} onLens={onLens}
        sub={<>{done}/{cards.length} done · {Math.round((done / Math.max(cards.length, 1)) * 100)}%{filtered && <> · showing {visible.length}</>}</>}>
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
        {byLane.map(([lane, list]) => (
          <section key={lane} className="tr-lane flex w-[290px] shrink-0 grow-0 flex-col rounded-xl bg-white/[0.025] p-2.5">
            <div className="mb-2.5 flex items-center gap-2 px-1.5 pt-1">
              <span className="tr-dot" style={{ background: LANE_COLOR[lane] }} />
              <span className="tr-label">{lane}</span>
              <span className="tr-mono ml-auto text-[11px] text-[var(--color-tr-muted)]">{list.length}</span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-0.5 pb-1">
              {list.slice(0, 200).map(c => (
                <CardTile key={c.id} card={c} onOpen={c2 => setOpen(c2.id)} onAdvance={advance} />
              ))}
            </div>
          </section>
        ))}
      </div>
      {open !== null && (
        <CardDetail client={client} id={open} onClose={() => setOpen(null)}
                    onMoved={() => client.tasks(project).then(setCards).catch(() => {})} />
      )}
    </div>
  );
}

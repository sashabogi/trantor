// BOARD — one of the two lenses (the other is FEED). Lanes of cards for a single project.
//
// Deliberately NOT a port of Buzz's UI: theirs is channels/messages/threads, ours is lanes/cards.
// What we take from them is the SHELL (sidebar + main), which is layout rather than code — so no
// Apache-2.0 obligations land on an MIT repo. Colours are Trantor's own: the same hex values
// bin/crew-runner.mjs already pushes into the cmux sidebar, so a seat that is "building" in the
// terminal is the same blue here.
import { useEffect, useState } from "react";
import type { Card, HubClient } from "../../shared/api/client";

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

function CardTile({ card }: { card: Card }) {
  return (
    <div className="rounded-lg border border-[var(--color-tr-edge)] bg-[var(--color-tr-panel)] p-3 text-sm">
      <div className="leading-snug">{card.title}</div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-tr-muted)]">
        {card.assignee && <span className="rounded bg-black/30 px-1.5 py-0.5">@{card.assignee}</span>}
        {card.difficulty && <span className="rounded bg-black/30 px-1.5 py-0.5">{card.difficulty[0].toUpperCase()}</span>}
        {card.model && <span className="rounded bg-black/30 px-1.5 py-0.5">{card.model}</span>}
        <span className="ml-auto opacity-60">#{card.id}</span>
      </div>
    </div>
  );
}

export function Board({ client, project }: { client: HubClient; project: string }) {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setCards(null); setError(null);
    client.tasks(project)
      .then(t => { if (alive) setCards(t); })
      .catch(e => { if (alive) setError(String(e.message || e)); });
    return () => { alive = false; };
  }, [client, project]);

  // Live updates ride the SAME stream the FEED uses. A card event is cheap to react to: refetch the
  // project rather than trying to replay hub-side card mutation logic in the client, which is exactly
  // the kind of duplicated state machine that drifts.
  useEffect(() => {
    return client.streamEvents(ev => {
      if (ev.project === project && ["created", "moved", "updated"].includes(ev.type)) {
        client.tasks(project).then(setCards).catch(() => {});
      }
    });
  }, [client, project]);

  if (error) return <div className="p-6 text-sm text-[var(--color-tr-fail)]">Board unavailable: {error}</div>;
  if (!cards) return <div className="p-6 text-sm text-[var(--color-tr-muted)]">Loading {project}…</div>;

  const byLane = LANES.map(l => [l, cards.filter(c => (c.status || "todo") === l)] as const);
  const done = cards.filter(c => c.status === "done").length;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-baseline gap-3 border-b border-[var(--color-tr-edge)] px-5 py-3">
        <h1 className="text-base font-semibold">{project}</h1>
        <span className="text-xs text-[var(--color-tr-muted)]">
          {done}/{cards.length} done · {Math.round((done / Math.max(cards.length, 1)) * 100)}%
        </span>
      </header>
      <div className="flex flex-1 gap-3 overflow-x-auto p-4">
        {byLane.map(([lane, list]) => (
          <section key={lane} className="flex min-w-[240px] flex-1 flex-col">
            <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wide">
              <span className="h-2 w-2 rounded-full" style={{ background: LANE_COLOR[lane] }} />
              <span className="text-[var(--color-tr-muted)]">{lane}</span>
              <span className="ml-auto text-[var(--color-tr-muted)]">{list.length}</span>
            </div>
            <div className="flex flex-col gap-2 overflow-y-auto">
              {list.slice(0, 200).map(c => <CardTile key={c.id} card={c} />)}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

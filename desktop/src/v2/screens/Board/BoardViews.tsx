import type { ReactNode } from "react";
import type { Card } from "../../../shared/api/client";
import { cleanTitle } from "../../../shared/Avatar";
import { Avatar } from "../../ui/Avatar";
import { dependencyRows, groupBySeat } from "./model";

export function SeatView({ cards, renderCard }: { cards: Card[]; renderCard: (card: Card) => ReactNode }) {
  const rows = groupBySeat(cards);
  if (!rows.length) return <div className="px-5 py-6 text-v2-base text-[var(--v2-muted)]">No cards match.</div>;
  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">
      {rows.map(row => (
        <section key={row.seat || "unassigned"} aria-label={`${row.label} cards`} className="border-t border-[var(--v2-edge)] py-3 first:border-t-0">
          <header className="mb-2 flex items-center gap-2">
            {row.seat && <Avatar name={row.seat} size={22} />}
            <h3 className="m-0 text-v2-base font-semibold">{row.label}</h3>
            <span className="text-v2-small text-[var(--v2-muted)]">{row.cards.length}</span>
          </header>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2">{row.cards.map(renderCard)}</div>
        </section>
      ))}
    </div>
  );
}

function CardLink({ card, onOpen }: { card: Card; onOpen: (id: number) => void }) {
  return (
    <button type="button" onClick={() => onOpen(card.id)} className="v2-hover block max-w-full truncate rounded border-0 bg-transparent p-0 text-left text-v2-body text-[var(--v2-text-2)]">
      #{card.id} {cleanTitle(card.title)}
    </button>
  );
}

export function DependenciesView({ cards, onOpen }: { cards: Card[]; onOpen: (id: number) => void }) {
  const rows = dependencyRows(cards);
  if (!rows.length) return <div className="px-5 py-6 text-v2-base text-[var(--v2-muted)]">No dependencies between open cards.</div>;
  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">
      <div className="mb-2 text-v2-small text-[var(--v2-muted)]">Open cards only. “Waits on” must finish first; “Unblocks” is waiting on this card.</div>
      {rows.map(({ card, waitsOn, blocks }) => (
        <section key={card.id} aria-label={`Dependencies for card ${card.id}`} className="grid grid-cols-[minmax(180px,1fr)_minmax(180px,1fr)_minmax(180px,1fr)] gap-4 border-t border-[var(--v2-edge)] py-3">
          <div><CardLink card={card} onOpen={onOpen} /><span className="text-v2-small text-[var(--v2-muted)]">{card.status}</span></div>
          <div><h4 className="m-0 mb-1 text-v2-small uppercase tracking-wide text-[var(--v2-muted)]">Waits on</h4>{waitsOn.map(c => <CardLink key={c.id} card={c} onOpen={onOpen} />)}</div>
          <div><h4 className="m-0 mb-1 text-v2-small uppercase tracking-wide text-[var(--v2-muted)]">Unblocks</h4>{blocks.map(c => <CardLink key={c.id} card={c} onOpen={onOpen} />)}</div>
        </section>
      ))}
    </div>
  );
}

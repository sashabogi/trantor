// The sub-agent roll-up: ONE quiet line at the foot of a lane standing in for every cc-subagent
// card in it. Collapsed by default, because these are the machine's own bookkeeping — on
// crebral-health they are 412 of the done lane's tiles, and as flat siblings they buried every
// piece of real work on the board.
//
// It is a LANE roll-up rather than a per-session one on purpose; Board.tsx documents why the
// per-session shape cannot be built on the current data.
import { useState } from "react";
import type { Card } from "../../shared/api/client";
import { cleanTitle } from "../../shared/Avatar";

function runCount(card: Card): number {
  return Math.max(1, Number(card.count ?? 1) || 1);
}

/** Cost is NULLABLE and null does not mean zero. The hub nulls historical sub-agent cost outright
 * (the v0.17.37 inflated-notional reset), and any turn the pricing table can't price stays
 * unpriced — so summing with `?? 0` and printing "$0.00" states a number nobody measured. Returns
 * null when NOTHING in the group had a real figure, and the caller renders no cost at all. */
function totalCost(cards: Card[]): number | null {
  let sum = 0, any = false;
  for (const c of cards) if (typeof c.costUsd === "number") { sum += c.costUsd; any = true; }
  return any ? sum : null;
}

const formatCost = (v: number) => `$${v.toFixed(2)}`;

export function SubagentGroup({ items, forceOpen, onOpen }: {
  items: Card[];
  forceOpen: boolean;
  onOpen: (card: Card) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const open = forceOpen || expanded;

  if (items.length === 0) return null;

  // Cards vs RUNS are different numbers and the label says which is which: the hub collapses
  // repeat sub-agent runs into one rolling card (counts reach 739 on a single card), so "198
  // cards" and "3094 runs" are both true and neither alone is honest.
  const runs = items.reduce((sum, child) => sum + runCount(child), 0);
  const cost = totalCost(items);
  // A lane can hold hundreds. Render a bounded slice and SAY the list is clipped rather than
  // silently dropping the tail — and never mount 400 rows into a 290px column.
  const LIMIT = 50;
  const shown = items.slice(0, LIMIT);

  return (
    <div className="mt-1 rounded-lg border border-dashed border-[var(--color-tr-edge)] p-2 text-[11px] text-[var(--color-tr-muted)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={e => { e.stopPropagation(); setExpanded(v => !v); }}
        className="flex w-full items-center gap-1.5 text-left hover:text-[var(--color-tr-text)]">
        <span className="shrink-0">{open ? "▾" : "▸"}</span>
        <span className="min-w-0 flex-1 truncate">
          <span className="tr-mono">{items.length}</span> sub-agent card{items.length === 1 ? "" : "s"}
          {runs > items.length && <> · <span className="tr-mono">{runs}</span> runs</>}
        </span>
        {cost !== null && <span className="tr-mono shrink-0">{formatCost(cost)}</span>}
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-1.5">
          {shown.map(child => (
            <button
              key={child.id}
              type="button"
              onClick={e => { e.stopPropagation(); onOpen(child); }}
              className="flex min-w-0 items-start gap-2 rounded px-1.5 py-1 text-left hover:bg-white/[0.03] hover:text-[var(--color-tr-text)]">
              <span className="tr-dot mt-1.5 shrink-0 bg-[var(--color-tr-muted)]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{child.agentType || "sub-agent"}</span>
                <span className="block truncate text-[var(--color-tr-muted)]">{cleanTitle(child.title)}</span>
              </span>
              {typeof child.costUsd === "number" && (
                <span className="tr-mono shrink-0">{formatCost(child.costUsd)}</span>
              )}
            </button>
          ))}
          {items.length > shown.length && (
            <span className="px-1.5 pt-0.5 text-[var(--color-tr-muted)]">
              + {items.length - shown.length} more not shown
            </span>
          )}
        </div>
      )}
    </div>
  );
}

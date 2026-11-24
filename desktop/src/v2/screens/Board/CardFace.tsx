// One card on the board: the artboard's face, with sub-agents rolled up underneath (#13989).
import { useState } from "react";
import type { Card } from "../../../shared/api/client";
import type { PresenceState } from "../../../shared/presence";
import { cleanTitle } from "../../../shared/Avatar";
import { Avatar } from "../../ui/Avatar";
import { Chip } from "../../ui/Chip";
import type { Presence } from "../../ui/identity";
import { dictGet } from "../../../shared/dict";
import { ageDays, agoShort, checklistOf, drillState, type BoardCard } from "./model";

const DIFFICULTY_COLOR = { easy: "var(--v2-ok)", medium: "#E2B86B", hard: "var(--v2-bad)" } as const satisfies Record<string, string>;

export function toPresence(p?: PresenceState): Presence | undefined {
  if (!p) return undefined;
  return p === "busy" ? "working" : p === "idle" ? "ready" : "offline";
}

export type NextStep = { label: string; title: string; run: () => void };

export type CardFaceProps = {
  card: BoardCard;
  presence?: PresenceState;
  selected: boolean;
  next?: NextStep;
  subagents?: Card[];
  forceOpenSubagents?: boolean;
  onOpen: (id: number) => void;
};

function DifficultyDot({ difficulty }: { difficulty?: string }) {
  const color = difficulty ? dictGet(DIFFICULTY_COLOR, difficulty) : undefined;
  return <span title={difficulty ?? "no difficulty set"} className="mt-[5px] h-[7px] w-[7px] shrink-0 rounded-full"
    style={{ background: color ?? "var(--v2-track)" }} />;
}

function ChecklistBar({ card }: { card: Card }) {
  const c = checklistOf(card);
  if (!c) return null;
  return (
    <span title={`${c.done} of ${c.total} acceptance items met`} className="inline-flex items-center gap-[5px] text-[10.5px] text-[var(--v2-muted)]">
      <span className="inline-block h-[3px] w-7 rounded-sm bg-[var(--v2-hover)]">
        <span className="block h-[3px] rounded-sm bg-[var(--v2-accent)]" style={{ width: `${(c.done / c.total) * 100}%` }} />
      </span>
      {c.done}/{c.total}
    </span>
  );
}

function DrillBadge({ card }: { card: BoardCard }) {
  const s = drillState(card);
  if (s === "owed") return <span title="drill owed: done is refused until it runs" className="inline-flex items-center gap-1 text-[10.5px] text-[var(--v2-warn)]"><span className="h-2 w-2 rounded-full border-[1.5px] border-[var(--v2-warn)]" />drill</span>;
  if (s === "none") return <span title="no drill line on the card: done is refused until one is added" className="inline-flex items-center gap-1 text-[10.5px] text-[var(--v2-bad)]"><span className="h-2 w-2 rounded-full border-[1.5px] border-[var(--v2-bad)]" />no drill line</span>;
  if (s === "set") return <span title="a drill line is on the card" className="inline-flex items-center gap-1 text-[10.5px] text-[var(--v2-ok)]">✓ drill</span>;
  return null;
}

function Subagents({ items, forceOpen, onOpen }: { items: Card[]; forceOpen: boolean; onOpen: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const shown = open || forceOpen;
  const runs = items.reduce((n, c) => n + Math.max(1, Number(c.count ?? 1) || 1), 0);
  return (
    <div className="flex flex-col gap-1">
      <button type="button" aria-expanded={shown} onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        className="v2-hover flex items-center gap-1.5 rounded-md border-0 bg-transparent px-1 py-0.5 text-left text-[10.5px] text-[var(--v2-muted)]">
        <span aria-hidden>{shown ? "▾" : "▸"}</span>{items.length} sub-agent{items.length === 1 ? "" : "s"} · {runs} run{runs === 1 ? "" : "s"}
      </button>
      {shown && items.map(k => (
        <button key={k.id} type="button" onClick={e => { e.stopPropagation(); onOpen(k.id); }}
          className="v2-hover flex items-center gap-1.5 rounded-md border-0 bg-transparent px-1 py-0.5 text-left text-[11px] text-[var(--v2-text-2)]">
          <span className="min-w-0 flex-1 truncate">{k.summary || cleanTitle(k.title)}</span>
          <span className="v2-mono shrink-0 text-[10px] text-[var(--v2-muted)]">{k.agentType ?? k.status}</span>
        </button>
      ))}
    </div>
  );
}

/** The lane-head roll-up for sub-agents whose parent session card is not on the board. */
export function SubagentRollup({ items, forceOpen, onOpen }: { items: Card[]; forceOpen: boolean; onOpen: (id: number) => void }) {
  if (!items.length) return null;
  return <Subagents items={items} forceOpen={forceOpen} onOpen={onOpen} />;
}

export function CardFace({ card, presence, selected, next, subagents, forceOpenSubagents, onOpen }: CardFaceProps) {
  const seat = card.workedBy || card.assignee;
  const age = card.status === "todo" ? ageDays(card) : 0;
  const aged = age > 7;
  return (
    <article data-card={card.id} data-selected={selected || undefined}
      className={`flex flex-col gap-[7px] rounded-[10px] border p-[9px_10px] ${selected ? "border-[var(--v2-accent)] bg-[#1B1E26]" : "border-[var(--v2-edge)] bg-[#15171B]"}`}>
      <button type="button" onClick={() => onOpen(card.id)} aria-label={`Open card #${card.id}`}
        className="flex cursor-pointer items-start gap-[7px] border-0 bg-transparent p-0 text-left text-[var(--v2-text)]">
        <DifficultyDot difficulty={card.difficulty} />
        <span className="min-w-0 flex-1 break-words text-[12.5px] leading-[1.35] [overflow-wrap:anywhere]">{card.summary || cleanTitle(card.title)}</span>
        <span className="v2-mono text-[10.5px] text-[#6B717A]">#{card.id}</span>
      </button>
      {(seat || card.model) && (
        <div className="flex flex-wrap items-center gap-[7px]">
          {seat && <Avatar name={seat} size={18} presence={toPresence(presence)} surface="#15171B" />}
          {card.model && <span className="v2-mono whitespace-nowrap text-[10.5px] text-[var(--v2-muted)]">{card.model}</span>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2.5">
        <ChecklistBar card={card} />
        <DrillBadge card={card} />
        {aged && <Chip tone={age >= 14 ? "warn" : "neutral"} title="untouched for over a week; the reaper stales it at 14d">{age}d in todo</Chip>}
      </div>
      <div className="flex items-center gap-1.5">
        <span title="last touched" className="flex-1 text-[10.5px] text-[#6B717A]">{card.status === "todo" ? `idle ${agoShort(card)}` : agoShort(card)}</span>
        {next && (
          <button type="button" title={next.title} onClick={next.run}
            className="whitespace-nowrap rounded-md border-0 bg-[var(--v2-text)] px-2 py-[3px] text-[11px] font-semibold text-[var(--v2-ink)] hover:bg-white">
            {next.label}
          </button>
        )}
      </div>
      {subagents && subagents.length > 0 && <Subagents items={subagents} forceOpen={!!forceOpenSubagents} onOpen={onOpen} />}
    </article>
  );
}

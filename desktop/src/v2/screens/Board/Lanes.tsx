// The lanes: todo, doing, testing (split in three groups), done, plus failed/blocked/stale strips (#13989).
import { useState, type ReactNode } from "react";
import type { Card } from "../../../shared/api/client";
import { SubagentRollup } from "./CardFace";
import { EXCEPTION_LANES, type BoardModel, type ExceptionLane, type Lane } from "./model";

const LANE_DOT = {
  todo: "var(--v2-muted)", doing: "var(--v2-accent)", testing: "var(--v2-warn)", done: "var(--v2-ok)",
  failed: "var(--v2-bad)", blocked: "var(--v2-bad)", stale: "var(--v2-track)",
} as const satisfies Record<string, string>;
const LANE_LABEL = { todo: "To do", doing: "Doing", testing: "Testing", done: "Done", failed: "Failed", blocked: "Blocked", stale: "Stale" } as const;
const DONE_PAGE = 25;

export type LanesProps = {
  model: BoardModel;
  filtering: boolean;
  renderCard: (c: Card) => ReactNode;
  onOpen: (id: number) => void;
};

function LaneHead({ lane, count }: { lane: keyof typeof LANE_DOT; count: number }) {
  return (
    <div className="flex items-center gap-[7px] px-0.5">
      <span className="h-2 w-2 rounded-full" style={{ background: LANE_DOT[lane] }} />
      <h3 className="m-0 text-v2-body font-semibold">{LANE_LABEL[lane]}</h3>
      <span className="text-v2-small text-[var(--v2-muted)]">{count}</span>
    </div>
  );
}

function Empty({ line }: { line: string }) {
  return <div className="rounded-lg border border-dashed border-[var(--v2-edge-2)] px-2.5 py-3 text-center text-v2-small text-[var(--v2-muted)]">{line}</div>;
}

function LaneColumn({ lane, data, width = 262, filtering, renderCard, onOpen, cap }: {
  lane: "todo" | "doing" | "done"; data: Lane; width?: number; cap?: number;
} & Pick<LanesProps, "filtering" | "renderCard" | "onOpen">) {
  const [all, setAll] = useState(false);
  const cards = cap && !all ? data.cards.slice(0, cap) : data.cards;
  const hidden = data.cards.length - cards.length;
  return (
    <section aria-label={LANE_LABEL[lane]} className="flex shrink-0 flex-col gap-2" style={{ width }}>
      <LaneHead lane={lane} count={data.cards.length + data.subagents.length} />
      <SubagentRollup items={data.subagents} forceOpen={filtering} onOpen={onOpen} />
      {cards.map(renderCard)}
      {hidden > 0 && (
        <button type="button" onClick={() => setAll(true)}
          className="v2-hover rounded-lg border border-dashed border-[var(--v2-edge-2)] bg-transparent p-2 text-v2-body font-medium text-[var(--v2-muted)]">
          {hidden} more · show
        </button>
      )}
      {!data.cards.length && !data.subagents.length && <Empty line={filtering ? "No cards match." : lane === "todo" ? "Nothing waiting." : lane === "doing" ? "Nobody is mid-card." : "Nothing done yet."} />}
    </section>
  );
}

function GroupHead({ label, count, note, open, onToggle }: { label: string; count: number; note: string; open?: boolean; onToggle?: () => void }) {
  const inner = (
    <>
      {onToggle && <span aria-hidden>{open ? "▾" : "▸"}</span>}
      <span className="flex-1 text-left">{label}</span>
      <span className="font-normal tracking-normal">{count}</span>
    </>
  );
  return (
    <>
      {onToggle
        ? <button type="button" aria-expanded={open} onClick={onToggle}
            className="flex items-center gap-1.5 border-0 bg-transparent px-0.5 pt-1 text-v2-small font-semibold tracking-[0.06em] text-[var(--v2-muted)]">{inner}</button>
        : <div className="flex items-center gap-1.5 px-0.5 pt-1 text-v2-small font-semibold tracking-[0.06em] text-[var(--v2-muted)]">{inner}</div>}
      <div className="px-0.5 text-v2-small text-[var(--v2-faint)]">{note}</div>
    </>
  );
}

function TestingColumn({ model, filtering, renderCard, onOpen }: LanesProps) {
  const [olderOpen, setOlderOpen] = useState(false);
  const { needs, gate, older } = model.split;
  const total = model.testing.cards.length + model.testing.subagents.length;
  return (
    <section aria-label="Testing" className="flex w-[290px] shrink-0 flex-col gap-2">
      <LaneHead lane="testing" count={total} />
      <SubagentRollup items={model.testing.subagents} forceOpen={filtering} onOpen={onOpen} />
      <GroupHead label="NEEDS YOUR DRILL" count={needs.length} note="the seat is done; done waits for you" />
      {needs.map(renderCard)}
      {!needs.length && <Empty line="No drill is waiting on you." />}
      <GroupHead label="GATE RUNNING" count={gate.length} note="the assignee is mid-turn; no drill yet" />
      {gate.map(renderCard)}
      <GroupHead label="OLDER THAN 7 DAYS" count={older.length} open={olderOpen} onToggle={() => setOlderOpen(o => !o)}
        note="probably shipped; reconcile checks git and closes what landed" />
      {olderOpen && older.map(renderCard)}
    </section>
  );
}

function ExceptionStrip({ lane, cards, open, onToggle }: { lane: ExceptionLane; cards: Card[]; open: boolean; onToggle: () => void }) {
  const titles = cards.slice(0, 3).map(c => `#${c.id} ${c.title}`).join(", ");
  return (
    <button type="button" aria-expanded={open} aria-label={`${LANE_LABEL[lane]}, ${cards.length}`} onClick={onToggle}
      title={`${cards.length} ${lane}: ${titles}${cards.length > 3 ? ", …" : ""}`}
      className="v2-hover flex w-10 shrink-0 flex-col items-center gap-2 self-stretch rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-sunken)] py-2.5 text-[var(--v2-text-2)]">
      <span className="h-2 w-2 rounded-full" style={{ background: LANE_DOT[lane] }} />
      <span className="text-v2-small font-bold">{cards.length}</span>
      <span className="text-v2-body font-semibold [writing-mode:vertical-rl]">{LANE_LABEL[lane]}</span>
    </button>
  );
}

function ExceptionColumn({ lane, cards, onClose, renderCard }: { lane: ExceptionLane; cards: Card[]; onClose: () => void; renderCard: LanesProps["renderCard"] }) {
  return (
    <section aria-label={LANE_LABEL[lane]} className="flex w-[240px] shrink-0 flex-col gap-2">
      <div className="flex items-center gap-[7px] px-0.5">
        <span className="h-2 w-2 rounded-full" style={{ background: LANE_DOT[lane] }} />
        <h3 className="m-0 flex-1 text-v2-body font-semibold">{LANE_LABEL[lane]}</h3>
        <button type="button" onClick={onClose} aria-label={`Collapse ${LANE_LABEL[lane]}`} title={`Collapse ${LANE_LABEL[lane]}`}
          className="v2-hover rounded border-0 bg-transparent px-1.5 text-[var(--v2-muted)]">×</button>
      </div>
      {cards.map(renderCard)}
    </section>
  );
}

export function Lanes(props: LanesProps) {
  const { model, filtering, renderCard, onOpen } = props;
  const [expanded, setExpanded] = useState<ExceptionLane[]>([]);
  const toggle = (l: ExceptionLane) => setExpanded(e => e.includes(l) ? e.filter(x => x !== l) : [...e, l]);
  const exceptions = EXCEPTION_LANES.map((l): [ExceptionLane, Card[]] => [l, [...model[l].cards, ...model[l].subagents]]).filter(([, c]) => c.length > 0);
  return (
    <div className="flex min-h-0 flex-1 items-start gap-3 overflow-auto px-5 pb-5 pt-1">
      <LaneColumn lane="todo" data={model.todo} filtering={filtering} renderCard={renderCard} onOpen={onOpen} />
      <LaneColumn lane="doing" data={model.doing} filtering={filtering} renderCard={renderCard} onOpen={onOpen} />
      <TestingColumn {...props} />
      <LaneColumn lane="done" data={model.done} width={226} cap={DONE_PAGE} filtering={filtering} renderCard={renderCard} onOpen={onOpen} />
      {exceptions.map(([l, cards]) => expanded.includes(l)
        ? <ExceptionColumn key={l} lane={l} cards={cards} onClose={() => toggle(l)} renderCard={renderCard} />
        : <ExceptionStrip key={l} lane={l} cards={cards} open={false} onToggle={() => toggle(l)} />)}
    </div>
  );
}

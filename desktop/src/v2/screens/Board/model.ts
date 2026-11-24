// Pure board logic: lanes, the testing split, filters, nesting, the drill line (#13989).
import type { Card } from "../../../shared/api/client";
import type { PresenceState } from "../../../shared/presence";
import { matchesCard } from "../../../features/search/match";
import { dictGet } from "../../../shared/dict";

/** The hub keeps `drill` on slim rows too, but the shared Card type does not declare it yet. */
export type BoardCard = Card & { drill?: string };

export const FLOW = ["todo", "doing", "testing", "done"] as const;
export const EXCEPTION_LANES = ["failed", "blocked", "stale"] as const;
export type ExceptionLane = (typeof EXCEPTION_LANES)[number];
export const DAY_MS = 864e5;

const NEXT = { todo: "doing", doing: "testing", testing: "done" } as const satisfies Record<string, string>;
export const nextOf = (status: string): string | undefined => dictGet(NEXT, status);

/** Forward ONE step (the gate stays a gate), back to any earlier stage; exception lanes re-enter at todo or doing. */
export function allowedMoves(status: string): string[] {
  const i = FLOW.findIndex(s => s === status);
  const next = nextOf(status);
  if (i >= 0) return [...FLOW.slice(0, i), ...(next ? [next] : [])];
  return ["todo", "doing"];
}

const DRILL_LINE = /^\s*drill:/i;

/** The drill line the hub's done gate accepts: the field, a "Drill:" checklist item or a "Drill:" log note. */
export function drillLine(card: BoardCard): string | null {
  const field = card.drill?.trim();
  if (field) return field;
  const item = card.checklist?.find(c => DRILL_LINE.test(c.text));
  if (item) return item.text.replace(DRILL_LINE, "").trim() || item.text;
  const note = card.log?.find(l => DRILL_LINE.test(l.text));
  return note ? note.text.replace(DRILL_LINE, "").trim() || note.text : null;
}

export const touchedAt = (c: Card): number => c.updated || c.ts || 0;

export function ageDays(c: Card, now = Date.now()): number {
  const t = touchedAt(c);
  return t ? Math.floor((now - t) / DAY_MS) : 0;
}

/** Compact "last touched": 12m, 3h, 6d. */
export function agoShort(c: Card, now = Date.now()): string {
  const t = touchedAt(c);
  if (!t) return "never";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export const isBusy = (c: Card, presence: Map<string, PresenceState>): boolean =>
  !!c.assignee && presence.get(c.assignee) === "busy";

export type Nesting = { childrenOf: Map<number, Card[]>; nested: Set<number> };

/** A sub-agent nests under the session card whose `cc` equals its `parent`; unresolved ones stay in the lane roll-up. */
export function buildNesting(cards: Card[]): Nesting {
  const focusByCc = new Map<string, Card>();
  for (const c of cards) if (c.source === "session" && c.cc) focusByCc.set(c.cc, c);
  const childrenOf = new Map<number, Card[]>();
  const nested = new Set<number>();
  for (const c of cards) {
    if (c.source !== "cc-subagent" || !c.parent) continue;
    const parent = focusByCc.get(c.parent);
    if (!parent) continue;
    const kids = childrenOf.get(parent.id);
    if (kids) kids.push(c); else childrenOf.set(parent.id, [c]);
    nested.add(c.id);
  }
  for (const kids of childrenOf.values()) kids.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  return { childrenOf, nested };
}

export type Filters = { query: string; seats: string[]; needsYou: boolean; drillOwed: boolean; nested: boolean };
export const NO_FILTERS: Filters = { query: "", seats: [], needsYou: false, drillOwed: false, nested: true };

export const isFiltering = (f: Filters): boolean => f.query.trim() !== "" || f.seats.length > 0 || f.needsYou || f.drillOwed;

/** What waits on the operator: a testing card nobody is driving, or anything failed or blocked. */
export function needsYou(c: Card, presence: Map<string, PresenceState>): boolean {
  return (c.status === "testing" && !isBusy(c, presence)) || c.status === "failed" || c.status === "blocked";
}

function passes(c: Card, f: Filters, presence: Map<string, PresenceState>): boolean {
  if (!matchesCard(c, f.query)) return false;
  if (f.seats.length > 0 && !(c.assignee && f.seats.includes(c.assignee))) return false;
  if (f.needsYou && !needsYou(c, presence)) return false;
  if (f.drillOwed && c.status !== "testing") return false;
  return true;
}

export type Lane = { cards: Card[]; subagents: Card[] };
export type TestingSplit = { needs: Card[]; gate: Card[]; older: Card[] };

export type BoardModel = {
  nesting: Nesting;
  todo: Lane; doing: Lane; testing: Lane; done: Lane; failed: Lane; blocked: Lane; stale: Lane;
  split: TestingSplit;
  /** cards that survived the filters, sub-agents included */
  shown: number;
};

/** Testing cards: older than a week (probably shipped), else waiting on the operator's drill, else a gate still running. */
export function splitTesting(cards: Card[], presence: Map<string, PresenceState>, now = Date.now()): TestingSplit {
  const out: TestingSplit = { needs: [], gate: [], older: [] };
  for (const c of cards) {
    if (ageDays(c, now) > 7) out.older.push(c);
    else if (isBusy(c, presence)) out.gate.push(c);
    else out.needs.push(c);
  }
  return out;
}

/** A parent stays when one of its nested children matches, so a match never vanishes with its tile. */
export function buildBoard(all: Card[], f: Filters, presence: Map<string, PresenceState>, now = Date.now()): BoardModel {
  const nesting = f.nested ? buildNesting(all) : { childrenOf: new Map<number, Card[]>(), nested: new Set<number>() };
  const hit = (c: Card) => passes(c, f, presence);
  const keep = (c: Card) => !nesting.nested.has(c.id) && (hit(c) || !!nesting.childrenOf.get(c.id)?.some(hit));
  const lane = (status: string): Lane => {
    const visible = all.filter(c => (c.status || "todo") === status && keep(c));
    return {
      cards: visible.filter(c => c.source !== "cc-subagent" || !f.nested),
      subagents: f.nested ? visible.filter(c => c.source === "cc-subagent") : [],
    };
  };
  const testing = lane("testing");
  const model: BoardModel = { nesting, todo: lane("todo"), doing: lane("doing"), testing, done: lane("done"),
    failed: lane("failed"), blocked: lane("blocked"), stale: lane("stale"), split: splitTesting(testing.cards, presence, now), shown: 0 };
  const lanes = [model.todo, model.doing, model.testing, model.done, model.failed, model.blocked, model.stale];
  model.shown = lanes.reduce((n, l) => n + l.cards.length + l.subagents.length, 0);
  return model;
}

export function countBy(all: Card[], presence: Map<string, PresenceState>) {
  return {
    needsYou: all.filter(c => needsYou(c, presence)).length,
    drillOwed: all.filter(c => c.status === "testing").length,
  };
}

export function seatsOf(all: Card[]): string[] {
  return [...new Set(all.map(c => c.assignee).filter((a): a is string => !!a))].sort();
}

export type DrillState = "owed" | "none" | "set" | null;

/** Testing: a drill line on the card means the drill is owed; none means done is refused. Done: a line means one was recorded. */
export function drillState(c: BoardCard): DrillState {
  const has = !!c.drill?.trim();
  if (c.status === "testing") return has ? "owed" : "none";
  if (c.status === "done" && has) return "set";
  return null;
}

export function checklistOf(c: Card): { done: number; total: number } | null {
  const total = c.checklistCount ?? c.checklist?.length ?? 0;
  if (!total) return null;
  return { done: c.checklistDone ?? c.checklist?.filter(i => i.done).length ?? 0, total };
}

/** File-looking tokens in a card's own text: the raw material for the card to code link. */
export function fileCandidates(texts: string[]): string[] {
  const out = new Set<string>();
  const re = /(?:^|[\s"'`(=,])((?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z]{1,6})(?=[\s"'`),.:;]|$)/g;
  let m: RegExpExecArray | null;
  const text = texts.join("\n");
  while ((m = re.exec(text)) && out.size < 40) out.add(m[1]);
  return [...out];
}

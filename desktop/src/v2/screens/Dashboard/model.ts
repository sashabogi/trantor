// Pure derivations for the 2.0 Dashboard: the ranked needs-you queue, live seats, tabs (#13986).
import type { ProjectActivity } from "../../../app/projectActivity";
import type { Card, FileHold, Message, Peer, Proposal } from "../../../shared/api/client";
import { stalenessOf } from "../../../features/inbox/staleness";
import { hubActivity } from "../../../features/workspace/seatActivity";
import { ONLINE_MS } from "../../../shared/presence";
import { seatLabel, type Presence } from "../../ui/identity";

export type QueueKind = "hold" | "proposal" | "message" | "testing";

export type QueueItem = {
  key: string;
  kind: QueueKind;
  project: string;
  title: string;
  /** The seat that is waiting, when one is. */
  seat: string;
  card?: Card;
  ts: number;
  hold?: FileHold;
  proposal?: Proposal;
  message?: Message;
  testingCount?: number;
};

// A held edit blocks two seats at once, so it outranks a proposal, then a question, then a review.
const KIND_RANK = { hold: 0, proposal: 1, message: 2, testing: 3 } as const satisfies Record<QueueKind, number>;

export function cardOfSeat(cards: Card[], project: string, seat: string): Card | undefined {
  const sameSeat = (name: string | undefined) => name === seat || (!!name && seatLabel(name) === seatLabel(seat));
  const mine = cards.filter(c => c.project === project && c.status === "doing" && (sameSeat(c.assignee) || sameSeat(c.workedBy)));
  return mine.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0];
}

export type QueueInput = {
  cards: Card[]; holds: FileHold[]; proposals: Proposal[]; messages: Message[];
  decided: ReadonlySet<string>;
  /** The whole inbox, seen included, so "asked again since" can see the newer message. Defaults to `messages`. */
  allMessages?: Message[];
  now?: number;
};

export const OLD_TESTING_MS = 7 * 86_400_000;
const cardAge = (c: Card) => c.updated ?? c.ts ?? 0;
// #13984 drill: a card that has sat in testing for weeks is backlog, not a drill waiting on the operator today.
const isOldTesting = (c: Card, now: number) => c.status === "testing" && now - cardAge(c) > OLD_TESTING_MS;

function testingRollups(cards: Card[], now: number): QueueItem[] {
  const per = new Map<string, Card[]>();
  for (const c of cards) {
    if (!isOldTesting(c, now)) continue;
    per.set(c.project, [...(per.get(c.project) ?? []), c]);
  }
  return [...per].map(([project, old]) => {
    const ts = Math.min(...old.map(cardAge));
    return { key: `testing:old:${project}`, kind: "testing", project, seat: "", ts, testingCount: old.length,
      title: `${project}: ${old.length} ${old.length === 1 ? "card" : "cards"} in testing over a week` };
  });
}

/** Everything that is waiting on the operator, across projects, ranked: kind first, then longest-waiting. */
export function buildQueue({ cards, holds, proposals, messages, decided, allMessages, now = Date.now() }: QueueInput): QueueItem[] {
  const everyone = allMessages ?? messages;
  const items: QueueItem[] = [];
  for (const h of holds) {
    items.push({ key: `hold:${h.id}`, kind: "hold", project: h.project, seat: h.session, ts: h.ts,
      card: cardOfSeat(cards, h.project, h.session), hold: h, title: `${seatLabel(h.session)} and ${seatLabel(h.other)} both edit ${h.file}` });
  }
  for (const p of proposals) {
    if (p.status !== "pending") continue;
    items.push({ key: `proposal:${p.id}`, kind: "proposal", project: p.project, seat: p.session, ts: p.ts,
      card: cardOfSeat(cards, p.project, p.session), proposal: p, title: `${seatLabel(p.session)} proposes: ${p.scope}` });
  }
  for (const m of messages) {
    // #13984 drill: the Inbox's own staleness rule, so the two screens never disagree on what is live.
    if (stalenessOf(m, everyone, [], cards).stale) continue;
    items.push({ key: `message:${m.id}`, kind: "message", project: m.project ?? "", seat: m.from, ts: m.ts,
      card: cardOfSeat(cards, m.project ?? "", m.from), message: m, title: `${seatLabel(m.from)}: ${m.text.split("\n")[0].slice(0, 140)}` });
  }
  for (const c of cards) {
    if (c.status !== "testing" || isOldTesting(c, now)) continue;
    items.push({ key: `testing:${c.id}`, kind: "testing", project: c.project, seat: c.workedBy ?? c.assignee ?? "", ts: c.updated ?? c.ts ?? 0,
      card: c, title: `#${c.id} ${c.title} is in testing, waiting for your drill` });
  }
  items.push(...testingRollups(cards, now));
  return items.filter(i => !decided.has(i.key)).sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.ts - b.ts);
}

export function actionableCount(items: QueueItem[]): number {
  return items.filter(i => i.kind !== "testing").length;
}

export type Seat = {
  session: string; project: string; model: string; machine: string;
  presence: Presence; status: string; lastSeen: number; card?: Card;
};

const SEAT_PRESENCE = { working: "working", blocked: "needs-you", idle: "ready" } as const;

/** Live agent seats: hub runner status, plus herdr activity for this machine's orchestrator sessions. */
export function liveSeats(peers: Peer[], cards: Card[], now: number = Date.now(), localActivity: ReadonlyMap<string, ProjectActivity> = new Map()): Seat[] {
  const out: Seat[] = [];
  for (const p of peers) {
    if (!p.project || p.kind === "tool" || p.online === false || now - (p.lastSeen ?? 0) > ONLINE_MS) continue;
    const act = hubActivity(p.status);
    if (act === "down") continue;
    const localWorking = seatLabel(p.session) === "orchestrator" && localActivity.get(p.project)?.state === "working";
    const presence = act === "working" || localWorking ? "working" : SEAT_PRESENCE[act];
    out.push({ session: p.session, project: p.project, model: p.model || p.llm || "", machine: p.machine ?? "",
      presence, status: p.status ?? "", lastSeen: p.lastSeen ?? 0, card: cardOfSeat(cards, p.project, p.session) });
  }
  return out.sort((a, b) => a.project.localeCompare(b.project) || a.session.localeCompare(b.session));
}

/** Projects that have at least one live seat, with the count, for the tab strip. */
export function seatTabs(seats: Seat[]): { project: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const s of seats) counts.set(s.project, (counts.get(s.project) ?? 0) + 1);
  return [...counts].map(([project, count]) => ({ project, count }));
}

export function seatsFor(seats: Seat[], tab: string): Seat[] {
  return tab ? seats.filter(s => s.project === tab) : seats;
}

/** "9m", "3h", "2d": how long ago, in the shortest unit that reads. */
export function span(ts: number | undefined, now: number = Date.now()): string {
  if (!ts) return "n/a";
  const m = Math.max(0, Math.round((now - ts) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

export function seatTime(s: Seat, now: number = Date.now()): string {
  const base = span(s.card?.updated ?? s.lastSeen, now);
  return s.presence === "ready" ? `idle · ${base}` : base;
}

export type DashboardGroup = { key: string; label: string; items: QueueItem[]; seats: Seat[] };

export function dashboardGroups(layout: "project" | "agent", items: QueueItem[], seats: Seat[]): DashboardGroup[] {
  const groups = new Map<string, DashboardGroup>();
  const ensure = (key: string, label: string) => {
    const existing = groups.get(key);
    if (existing) return existing;
    const made: DashboardGroup = { key, label, items: [], seats: [] };
    groups.set(key, made);
    return made;
  };
  for (const item of items) {
    const key = layout === "project" ? item.project : item.seat || item.project;
    const label = layout === "project" ? item.project || "No project" : item.seat ? seatLabel(item.seat) : `${item.project} reviews`;
    ensure(key || "none", label).items.push(item);
  }
  for (const seat of seats) {
    const key = layout === "project" ? seat.project : seat.session;
    const label = layout === "project" ? seat.project : seatLabel(seat.session);
    ensure(key || "none", label).seats.push(seat);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export const ACTIVE_PROJECT_MS = 14 * 86_400_000;

export function activeProjects(projects: string[], cards: Card[], live: Iterable<string>, now: number = Date.now()): Set<string> {
  const active = new Set(live);
  for (const c of cards) {
    if (projects.includes(c.project) && now - cardAge(c) <= ACTIVE_PROJECT_MS) active.add(c.project);
  }
  return active;
}

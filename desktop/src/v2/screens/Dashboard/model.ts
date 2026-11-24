// Pure derivations for the 2.0 Dashboard: the ranked needs-you queue, live seats, tabs (#13986).
import type { Card, FileHold, Message, Peer, Proposal } from "../../../shared/api/client";
import { stalenessOf } from "../../../features/inbox/staleness";
import { hubActivity } from "../../../features/workspace/seatActivity";
import { ONLINE_MS } from "../../../shared/presence";
import type { Presence } from "../../ui/identity";

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
};

// A held edit blocks two seats at once, so it outranks a proposal, then a question, then a review.
const KIND_RANK = { hold: 0, proposal: 1, message: 2, testing: 3 } as const satisfies Record<QueueKind, number>;

export function cardOfSeat(cards: Card[], project: string, seat: string): Card | undefined {
  const mine = cards.filter(c => c.project === project && c.status === "doing" && (c.assignee === seat || c.workedBy === seat));
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

/** The testing cards past a week, as one count and the project holding most of them. */
export type OldTesting = { count: number; project: string };

export function oldTesting(cards: Card[], now: number = Date.now()): OldTesting {
  const per = new Map<string, number>();
  let count = 0;
  for (const c of cards) {
    if (!isOldTesting(c, now)) continue;
    count += 1;
    per.set(c.project, (per.get(c.project) ?? 0) + 1);
  }
  const top = [...per].sort((a, b) => b[1] - a[1])[0];
  return { count, project: top ? top[0] : "" };
}

/** Everything that is waiting on the operator, across projects, ranked: kind first, then longest-waiting. */
export function buildQueue({ cards, holds, proposals, messages, decided, allMessages, now = Date.now() }: QueueInput): QueueItem[] {
  const everyone = allMessages ?? messages;
  const items: QueueItem[] = [];
  for (const h of holds) {
    items.push({ key: `hold:${h.id}`, kind: "hold", project: h.project, seat: h.session, ts: h.ts,
      card: cardOfSeat(cards, h.project, h.session), hold: h, title: `${h.session} and ${h.other} both edit ${h.file}` });
  }
  for (const p of proposals) {
    if (p.status !== "pending") continue;
    items.push({ key: `proposal:${p.id}`, kind: "proposal", project: p.project, seat: p.session, ts: p.ts,
      card: cardOfSeat(cards, p.project, p.session), proposal: p, title: `${p.session} proposes: ${p.scope}` });
  }
  for (const m of messages) {
    // #13984 drill: the Inbox's own staleness rule, so the two screens never disagree on what is live.
    if (stalenessOf(m, everyone, [], cards).stale) continue;
    items.push({ key: `message:${m.id}`, kind: "message", project: m.project ?? "", seat: m.from, ts: m.ts,
      card: cardOfSeat(cards, m.project ?? "", m.from), message: m, title: `${m.from}: ${m.text.split("\n")[0].slice(0, 140)}` });
  }
  for (const c of cards) {
    if (c.status !== "testing" || isOldTesting(c, now)) continue;
    items.push({ key: `testing:${c.id}`, kind: "testing", project: c.project, seat: c.workedBy ?? c.assignee ?? "", ts: c.updated ?? c.ts ?? 0,
      card: c, title: `#${c.id} ${c.title} is in testing, waiting for your drill` });
  }
  return items.filter(i => !decided.has(i.key)).sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.ts - b.ts);
}

export type Seat = {
  session: string; project: string; model: string; machine: string;
  presence: Presence; status: string; lastSeen: number; card?: Card;
};

const SEAT_PRESENCE = { working: "working", blocked: "needs-you", idle: "ready" } as const;

/** Live agent seats: online peers with a project that are crew or orchestrator sessions, not the CLI tool. */
export function liveSeats(peers: Peer[], cards: Card[], now: number = Date.now()): Seat[] {
  const out: Seat[] = [];
  for (const p of peers) {
    if (!p.project || p.kind === "tool" || p.online === false || now - (p.lastSeen ?? 0) > ONLINE_MS) continue;
    const act = hubActivity(p.status);
    if (act === "down") continue;
    out.push({ session: p.session, project: p.project, model: p.model || p.llm || "", machine: p.machine ?? "",
      presence: SEAT_PRESENCE[act], status: p.status ?? "", lastSeen: p.lastSeen ?? 0, card: cardOfSeat(cards, p.project, p.session) });
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
  if (!ts) return "—";
  const m = Math.max(0, Math.round((now - ts) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

export function seatTime(s: Seat, now: number = Date.now()): string {
  const base = span(s.card?.updated ?? s.lastSeen, now);
  return s.presence === "ready" ? `idle · ${base}` : base;
}

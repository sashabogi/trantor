import type { Card, FileHold, Message, Peer, Proposal } from "../../../shared/api/client";
import { stalenessOf, type Staleness } from "../../../features/inbox/staleness";

export type InboxFilter = "needs" | "questions" | "proposals" | "collisions" | "stale" | "answered";
export type InboxSort = "ranked" | "newest" | "project";

type ItemBase = {
  key: string;
  ts: number;
  project: string;
  from: string;
  title: string;
  unblocks: number;
  unblockLabel: string;
};

export type MessageItem = ItemBase & {
  kind: "question";
  message: Message;
  stale: Staleness;
};
export type HoldItem = ItemBase & { kind: "collision"; hold: FileHold };
export type ProposalItem = ItemBase & { kind: "proposal"; proposal: Proposal };
export type InboxItem = MessageItem | HoldItem | ProposalItem;

export type InboxModelInput = {
  messages: Message[];
  proposals: Proposal[];
  holds: FileHold[];
  peers: Peer[];
  cards: Card[];
};

const CLOSED = new Set(["done", "failed", "stale", "cancelled"]);
const openRefs = (message: Message, cards: Card[]) =>
  (message.refs ?? []).filter(id => cards.some(card => card.id === id && !CLOSED.has(card.status)));

function messageItem(message: Message, input: InboxModelInput): MessageItem {
  const refs = openRefs(message, input.cards);
  return {
    key: `message-${message.id}`, kind: "question", message, ts: message.ts,
    project: message.project ?? "", from: message.from, title: message.text,
    unblocks: refs.length,
    unblockLabel: refs.length ? `Unblocks ${refs.map(id => `#${id}`).join(" and ")}` : "Waiting on your answer",
    stale: stalenessOf(message, input.messages, input.peers, input.cards),
  };
}

function holdItem(hold: FileHold): HoldItem {
  const seats = new Set([hold.session, hold.other]);
  return {
    key: `hold-${hold.project}-${hold.id}`, kind: "collision", hold, ts: hold.ts,
    project: hold.project, from: `${hold.session} and ${hold.other}`,
    title: `Both want ${hold.file}: held for your go`, unblocks: seats.size,
    unblockLabel: `Holding ${seats.size} ${seats.size === 1 ? "seat" : "seats"} until you pick`,
  };
}

function proposalItem(proposal: Proposal): ProposalItem {
  return {
    key: `proposal-${proposal.project}-${proposal.id}`, kind: "proposal", proposal, ts: proposal.ts,
    project: proposal.project, from: proposal.session, title: `Proposal #${proposal.id}: ${proposal.scope}`,
    unblocks: 1, unblockLabel: "A standing grant; you set the bound",
  };
}

export function makeInboxItems(input: InboxModelInput): InboxItem[] {
  return [
    ...input.messages.map(message => messageItem(message, input)),
    ...input.holds.map(holdItem),
    ...input.proposals.map(proposalItem),
  ];
}

// #13990: an answer's value is the open cards or held seats it releases, not the row's age.
export function rankInboxItems<T extends InboxItem>(items: T[], sort: InboxSort = "ranked"): T[] {
  return [...items].sort((a, b) => {
    if (sort === "newest") return b.ts - a.ts;
    if (sort === "project") return a.project.localeCompare(b.project) || b.ts - a.ts;
    return b.unblocks - a.unblocks || b.ts - a.ts || a.key.localeCompare(b.key);
  });
}

export function splitStaleItems(items: InboxItem[]) {
  return {
    live: items.filter(item => item.kind !== "question" || !item.stale.stale),
    stale: items.filter((item): item is MessageItem => item.kind === "question" && item.stale.stale),
  };
}

export function isStale(item: InboxItem): boolean {
  return item.kind === "question" && item.stale.stale;
}

export function itemMatches(item: InboxItem, filter: InboxFilter, settled: ReadonlySet<string>): boolean {
  const done = settled.has(item.key);
  if (filter === "answered") return done;
  if (done) return false;
  if (filter === "stale") return isStale(item);
  if (isStale(item)) return false;
  if (filter === "needs") return true;
  return item.kind === filter.slice(0, -1);
}

export function searchInboxItems(items: InboxItem[], query: string, project: string): InboxItem[] {
  const needle = query.trim().toLowerCase();
  return items.filter(item => {
    if (project && item.project !== project) return false;
    if (!needle) return true;
    const refs = item.kind === "question" ? (item.message.refs ?? []).map(id => `#${id}`).join(" ") : "";
    return `${item.title} ${item.from} ${item.project} ${refs}`.toLowerCase().includes(needle);
  });
}

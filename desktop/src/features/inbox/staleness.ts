// Staleness is computed, not guessed: a message is stale once every card it references is
// closed, a newer message from the same sender supersedes it, or it has waited over a week
// without any open cited card. Sender online status is deliberately NOT a signal: a session
// idling between turns says nothing about whether the work it asked about still matters.
import type { Card, Message, Peer } from "../../shared/api/client";

/** Card statuses that mean the work this message was about is over. */
const CLOSED = new Set(["done", "failed", "stale", "cancelled"]);
const DAY_MS = 86_400_000;
export const STALE_QUESTION_MS = 7 * DAY_MS;

export type Staleness = { stale: true; reason: string } | { stale: false };

export function stalenessOf(
  msg: Message,
  all: Message[],
  _peers: Peer[],
  cards: Card[],
  now = Date.now(),
): Staleness {
  // 2. Asked again. Checked first because it is the most specific: if the same seat has spoken
  // since, the newer message is the live one and answering this would answer the wrong question.
  const newer = all.find(m => m.from === msg.from && m.id > msg.id);
  if (newer) return { stale: true, reason: `${msg.from} asked again since` };

  // 1. The work is over. Only when the message cites cards AND every one of them is closed — a
  // single open card means the thread is still live.
  const refs = msg.refs ?? [];
  if (refs.length) {
    const cited = cards.filter(c => refs.includes(c.id));
    if (cited.length === refs.length && cited.every(c => CLOSED.has(c.status))) {
      const ids = cited.map(c => `#${c.id}`).join(", ");
      return { stale: true, reason: `${ids} ${cited.length > 1 ? "are" : "is"} ${cited[0]?.status ?? "closed"}` };
    }
  }

  // 3. Abandoned. An open cited card keeps even an old question live; without one, an unanswered
  // question eventually stops being a demand on the operator. This decision is independent of the
  // supplied message list, so the Inbox and Dashboard cannot disagree about it.
  const age = now - msg.ts;
  const hasOpenCard = refs.some(id => cards.some(c => c.id === id && !CLOSED.has(c.status)));
  if (age > STALE_QUESTION_MS && !hasOpenCard) {
    return { stale: true, reason: `asked ${Math.floor(age / DAY_MS)}d ago; no open card` };
  }

  return { stale: false };
}

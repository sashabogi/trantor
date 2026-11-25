// Staleness is computed, not guessed: a message is stale once every card it references is
// closed, or a newer message from the same sender supersedes it. Deliberately NOT signals:
// age (how long you've been slow to answer) and sender online status (a session idling
// between turns says nothing about whether the work it asked about still matters).
import type { Card, Message, Peer } from "../../shared/api/client";

/** Card statuses that mean the work this message was about is over. */
const CLOSED = new Set(["done", "failed", "stale", "cancelled"]);

export type Staleness = { stale: true; reason: string } | { stale: false };

export function stalenessOf(
  msg: Message,
  all: Message[],
  _peers: Peer[],
  cards: Card[],
  _now = Date.now(),
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

  return { stale: false };
}

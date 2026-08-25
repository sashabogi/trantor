// Is this message still worth answering?
//
// An inbox that only stores messages makes the human do the expensive part: work out, for each
// question, whether anyone is still waiting for the answer. Most of the time nobody is. The seat
// that asked has died, or the card it was about is finished, or the same seat asked again an hour
// later. Answering those costs a decision and buys nothing, and worse, it teaches you to ignore the
// inbox — which is where a message that DID matter goes to die.
//
// So staleness is computed, not guessed, from three things the hub already tells us:
//   1. the work is finished   — the cards the hub parsed out of the text (`refs`) are all closed
//   2. it was asked again     — a newer message from the same sender supersedes it
//
// Deliberately NOT signals:
//
//   * Age on its own. "Waiting 9h" is how long YOU have been slow, not whether it still matters.
//
//   * Whether the sender is online. This was tried and withdrawn the same evening. It marked a
//     live, healthy duty seat — running six hours, seen by the hub two minutes earlier — as "gone
//     a while", because the view fetched peers once on mount and then compared that frozen
//     lastSeen against a live clock. But the stale data only exposed the real error: a message's
//     meaning does not depend on whether its author happens to be running right now. Agents idle
//     between turns and sessions end normally; "the hub:duty self-echo bug is still unfixed" is
//     just as true after the seat that reported it goes home. Both remaining signals are about the
//     WORK, which is the only thing that can actually stop mattering.
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

// Is this message still worth answering?
//
// An inbox that only stores messages makes the human do the expensive part: work out, for each
// question, whether anyone is still waiting for the answer. Most of the time nobody is. The seat
// that asked has died, or the card it was about is finished, or the same seat asked again an hour
// later. Answering those costs a decision and buys nothing, and worse, it teaches you to ignore the
// inbox — which is where a message that DID matter goes to die.
//
// So staleness is computed, not guessed, from three things the hub already tells us:
//   1. the asker is gone      — presence, the same lastSeen every other view reads
//   2. the work is finished   — the cards the hub parsed out of the text (`refs`) are all closed
//   3. it was asked again     — a newer message from the same sender supersedes it
//
// Deliberately NOT a signal: age on its own. "Waiting 9h" is how long you have been slow, not
// whether it still matters, and conflating the two is how a real question gets dismissed.
import type { Card, Message, Peer } from "../../shared/api/client";

/** How long a peer can be silent before we treat the asker as gone. Matches the hub's online window. */
const GONE_MS = 5 * 60 * 1000;

/** Card statuses that mean the work this message was about is over. */
const CLOSED = new Set(["done", "failed", "stale", "cancelled"]);

export type Staleness = { stale: true; reason: string } | { stale: false };

export function stalenessOf(
  msg: Message,
  all: Message[],
  peers: Peer[],
  cards: Card[],
  now = Date.now(),
): Staleness {
  // 3. Asked again. Checked first because it is the most specific: if the same seat has spoken
  // since, the newer message is the live one and answering this would answer the wrong question.
  const newer = all.find(m => m.from === msg.from && m.id > msg.id);
  if (newer) return { stale: true, reason: `${msg.from} asked again since` };

  // 2. The work is over. Only when the message cites cards AND every one of them is closed — a
  // single open card means the thread is still live.
  const refs = msg.refs ?? [];
  if (refs.length) {
    const cited = cards.filter(c => refs.includes(c.id));
    if (cited.length === refs.length && cited.every(c => CLOSED.has(c.status))) {
      const ids = cited.map(c => `#${c.id}`).join(", ");
      return { stale: true, reason: `${ids} ${cited.length > 1 ? "are" : "is"} ${cited[0]?.status ?? "closed"}` };
    }
  }

  // 1. The asker is gone. Last, because it is the bluntest: a seat can die holding a question that
  // still deserves an answer from whoever picks the work up — so this reads as "nobody is waiting",
  // never as "this did not matter".
  const peer = peers.find(p => p.session === msg.from);
  const lastSeen = peer?.lastSeen ?? 0;
  if (!peer || now - lastSeen > GONE_MS) {
    return { stale: true, reason: peer ? `${msg.from} has been gone a while` : `${msg.from} is not on the bus` };
  }

  return { stale: false };
}

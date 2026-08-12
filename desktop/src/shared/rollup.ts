// Roll-up for overseer history, shared by the Overseer view and Home's Collisions pointer.
//
// History repeats itself — literally. Before episode-based warning (hub 0.17.66) a standing
// condition re-fired every dedup window, so the log holds hundreds of identical rows: 500 events
// for four distinct conditions in one 8-day audit. Any surface that renders that log one-row-per-
// event reads as a stuck record. This lives in ONE place because it shipped in two: the Overseer
// view got the roll-up and Home did not, which is exactly the drift the design system warns about.
import type { HubEvent } from "./api/client";

export type Rolled = { rep: HubEvent; count: number; first: number; last: number };

export function rollUp(events: HubEvent[]): Rolled[] {
  const by = new Map<string, Rolled>();
  for (const e of events) {
    const any = e as Record<string, unknown>;
    const sig = `${e.type}|${e.project}|${String(any.kind ?? "")}|${String(any.detail ?? any.claim ?? "")}`;
    const cur = by.get(sig);
    if (!cur) by.set(sig, { rep: e, count: 1, first: e.ts, last: e.ts });
    else {
      cur.count++;
      cur.first = Math.min(cur.first, e.ts);
      cur.last = Math.max(cur.last, e.ts);
      // Prefer a NARRATED representative: narration lands on individual events, so the newest
      // event is often the one the cheap model hasn't reached yet.
      if (!(cur.rep as Record<string, unknown>).narration && (any.narration || e.ts > cur.rep.ts)) cur.rep = e;
    }
  }
  return [...by.values()].sort((a, b) => b.last - a.last);
}

/** How long a condition has held — "standing 4h" reads very differently from a bare repeated fact. */
export function lasting(ts?: number) {
  if (!ts) return "";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 90) return "just started";
  if (s < 3600) return `standing ${Math.round(s / 60)}m`;
  if (s < 86400) return `standing ${Math.round(s / 3600)}h`;
  return `standing ${Math.round(s / 86400)}d`;
}

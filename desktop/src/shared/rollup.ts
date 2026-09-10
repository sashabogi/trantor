// Roll-up for overseer history, shared by the Overseer view and Home's Collisions pointer.
// A standing condition re-fires every dedup window, so the raw log holds many near-identical
// rows; rendering one-row-per-event reads as stuck. Lives in ONE place because it shipped in
// two before (Overseer got it, Home did not), exactly the drift the design system warns about.
import type { HubEvent } from "./api/client";

export type Rolled = { rep: HubEvent; count: number; first: number; last: number };

export function rollUp(events: HubEvent[]): Rolled[] {
  const by = new Map<string, Rolled>();
  for (const e of events) {
    const sig = `${e.type}|${e.project}|${e.kind ?? ""}|${e.detail ?? e.claim ?? ""}`;
    const cur = by.get(sig);
    if (!cur) by.set(sig, { rep: e, count: 1, first: e.ts, last: e.ts });
    else {
      cur.count++;
      cur.first = Math.min(cur.first, e.ts);
      cur.last = Math.max(cur.last, e.ts);
      // Prefer a NARRATED representative: narration lands on individual events, so the newest
      // event is often the one the cheap model hasn't reached yet.
      if (!cur.rep.narration && (e.narration || e.ts > cur.rep.ts)) cur.rep = e;
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

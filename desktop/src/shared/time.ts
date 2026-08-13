// One clock for every surface. "8:33 PM" with no date is an anti-timestamp: it looks precise
// while hiding the only fact that matters — whether that was ten minutes ago or last Tuesday
// (Sasha, reading the Inbox: "God knows what date that was"). Every timestamp a human sees says
// its day the moment it is no longer today.

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** "2:13 PM" today · "yesterday 8:33 PM" · "Tue 8:33 PM" this week · "Aug 12, 8:33 PM" beyond. */
export function when(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (sameDay(d, now)) return clock(ts);
  const yday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (sameDay(d, yday)) return `yesterday ${clock(ts)}`;
  if (now.getTime() - ts < 7 * 24 * 60 * 60 * 1000) {
    return `${d.toLocaleDateString([], { weekday: "short" })} ${clock(ts)}`;
  }
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${clock(ts)}`;
}

/** "12m ago" · "18h ago" · "3d ago" — the age of a thing, for judging whether it still matters. */
export function ago(ts: number): string {
  const m = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Which messages the HUMAN has actually looked at.
//
// The inbox badge used to call client.inbox(me) with the default since=0 and count everything it
// got back, so it was a lifetime total dressed up as an unread count: it only ever went up, and
// nothing you did in the app could bring it down.
//
// The fix cannot be the hub's delivery cursor. That ledger belongs to the receiving SESSION's hooks,
// and the badge reads with peek=1 precisely so that glancing at it never steals a message a session
// still has to act on. So "seen" is a local, human-side notion, kept here and persisted, and the
// badge is simply (direct messages to me) minus (ids I have seen).
const KEY = "trantor.seenMessageIds";
const CAP = 2000;   // ids are monotonic; keeping the newest few thousand is plenty and bounds growth

let seen: Set<number> = load();
const listeners = new Set<() => void>();

/** Parse the stored value at its I/O boundary into message ids, discarding anything that is not one. */
function parseIds(raw: string | null): number[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const ids: number[] = [];
  for (const entry of parsed) {
    const id = Number(entry);
    if (Number.isSafeInteger(id) && id > 0) ids.push(id);
  }
  return ids;
}

function load(): Set<number> {
  try { return new Set(parseIds(localStorage.getItem(KEY))); } catch { return new Set(); }
}

function persist() {
  try {
    // Keep the newest CAP ids. Dropping the oldest can only ever make an ancient message look
    // unread again, which is far better than unbounded storage, and in practice they fall off the
    // hub's own 5,000-message window first.
    const arr = [...seen].sort((a, b) => b - a).slice(0, CAP);
    seen = new Set(arr);
    localStorage.setItem(KEY, JSON.stringify(arr));
  } catch { /* private mode, quota — the badge degrades to counting everything, never breaks */ }
}

export function hasSeen(id: number): boolean {
  return seen.has(id);
}

/** Mark one message read. No-op if it already was, so callers can fire this freely. */
export function markSeen(id: number): void {
  if (!Number.isFinite(id) || seen.has(id)) return;
  seen.add(id);
  persist();
  for (const fn of listeners) fn();
}

/** Count of ids not yet seen. */
export function countUnseen(ids: number[]): number {
  let n = 0;
  for (const id of ids) if (!seen.has(id)) n++;
  return n;
}

/** Subscribe to changes so the badge re-renders the moment a row is read. */
export function onSeenChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

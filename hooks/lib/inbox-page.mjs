// relay_inbox paging (#9822): an overnight backlog once returned 197K chars in ONE tool result.
// formatInboxPage bounds every read: newest-first, ≤ INBOX_PAGE_SIZE messages, capped near
// INBOX_PAGE_CHARS, repeated context notices collapsed ×N, footer carrying the before-cursor.
// Contracts (wake) and questions are never collapsed.
export const INBOX_PAGE_SIZE = 40;
export const INBOX_PAGE_CHARS = 20000;

// Same line shape mcp.mjs has always emitted, so inbox and wait read identically.
export const fmtMessage = (m) => `#${m.id} [${m.from} -> ${m.to}] ${new Date(m.ts).toLocaleTimeString()}: ${m.text}`;

// Stripping digit runs folds "12:04:11" and "3 cards" into one shape, so the same notice at
// different times and counts is one repeat. A kind (ask), a wake (contract), or a question mark
// opts the message out of collapsing entirely.
const collapsible = (m) => !m.kind && m.wake === false && !String(m.text || "").includes("?");
const collapseKey = (m) => `${m.from}|${String(m.text || "").replace(/\d+/g, "#")}`;

// Newest-first entries {m, n}: n counts how many messages the representative stands for.
export function collapseMessages(messages) {
  const entries = [];
  const seen = new Map();
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!collapsible(m)) { entries.push({ m, n: 1 }); continue; }
    const key = collapseKey(m);
    const at = seen.get(key);
    if (at === undefined) { seen.set(key, entries.length); entries.push({ m, n: 1 }); }
    else entries[at].n++;
  }
  return entries;
}

// messages ascending by id (the hub's order) -> bounded newest-first text. The page is the newest
// `limit` messages that fit the char cap — a CONTIGUOUS slice, so before-cursor paging has no gaps
// and no double-shown repeats; collapsing is display-only inside the window. Returns
// { text, shown, hidden, before } — before pages further back via relay_inbox({before}).
export function formatInboxPage(messages, { limit = INBOX_PAGE_SIZE, capChars = INBOX_PAGE_CHARS } = {}) {
  const list = messages || [];
  const window = [];
  let chars = 0;
  for (let i = list.length - 1; i >= 0 && window.length < limit; i--) {
    const lineLen = fmtMessage(list[i]).length + 8; // slack for a ×N suffix
    // The first line always lands, however long — an empty page would read as "no messages".
    if (window.length && chars + lineLen + 1 > capChars) break;
    window.push(list[i]);
    chars += lineLen + 1;
  }
  const lines = collapseMessages(window.slice().reverse()).map(e => fmtMessage(e.m) + (e.n > 1 ? `  (×${e.n})` : ""));
  const hidden = list.length - window.length;
  let text = lines.join("\n");
  let before = 0;
  const oldestShownId = Number(window[window.length - 1]?.id) || 0;
  if (hidden > 0 && oldestShownId) {
    before = oldestShownId;
    const footer = `… ${hidden} older not shown — relay_inbox({before:${before}}) for more`;
    text = text ? `${text}\n${footer}` : footer;
  }
  return { text, shown: window.length, hidden, before };
}

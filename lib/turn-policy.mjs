// Per-turn policy for a crew seat (#6134) — the rules that decide whether a bus message is worth
// a CLI turn at all, which card a session belongs to, what a turn cost, and when an exhausted seat
// is allowed to be woken again.
//
// These live here rather than in bin/crew-runner.mjs because the runner is a self-executing script
// (top-level await, spawns turns on import), so nothing in it can be unit-tested directly. The
// drill still drives the REAL runner end to end; these functions are what it can assert on cheaply.
//
// The burn this exists to stop: on 09-02 the fleet spent 151 turns and ~16 agentic hours, codex
// alone taking 60 turns of pure redelivery, and qwen 85.7M tokens at 96.7% cached — i.e. the same
// history replayed over and over. Every rule below removes one class of turn that never had work
// in it.

/// The first card a message cites. A turn belongs to exactly one card, and this is how the runner
/// knows when a wake has moved to a different one.
export const CARD_REF_RE = /#(\d{1,7})(?!\d)/;

/// Words that make a direct message an instruction rather than conversation. Deliberately short:
/// the point is to catch a contract that forgot to cite its card, not to parse English.
export const IMPERATIVE_RE = /\b(deliver|fix|bounce|contract|next|resume)\b/i;

export function cardRef(text) {
  const m = CARD_REF_RE.exec(String(text || ""));
  return m ? Number(m[1]) : 0;
}

export function hasImperative(text) {
  return IMPERATIVE_RE.test(String(text || ""));
}

/// The safety net for a sender that never set `wake`: a direct message with no card and no
/// imperative is an ack, an FYI or a queue note, and it batches into the next turn's context.
export function carriesWork(text) {
  return cardRef(text) > 0 || hasImperative(text);
}

// ---- what a turn cost -------------------------------------------------------------------------
// Each CLI reports its own usage in its own words, and some report none at all. Ordered most
// specific first; the LAST match of the first pattern that hits wins, because a CLI that prints a
// running total prints the real one last. Zero means "this CLI said nothing", never "free".
const TOKEN_PATTERNS = [
  /tokens used[:\s]+([\d,]+)/gi,        // codex
  /\btotal tokens[:\s]+([\d,]+)/gi,     // opencode / glm / deepseek summaries
  /\btokens[:\s]+([\d,]+)/gi,           // "Tokens: 12,345"
  /([\d,]+)\s+tokens\b/gi,              // "12,345 tokens"
];

export function parseTurnTokens(text) {
  const s = String(text || "");
  for (const re of TOKEN_PATTERNS) {
    re.lastIndex = 0;
    let last = 0;
    for (const m of s.matchAll(re)) {
      const n = Number(String(m[1]).replace(/,/g, ""));
      if (Number.isFinite(n)) last = n;
    }
    if (last) return last;
  }
  return 0;
}

// ---- when an exhausted seat may be woken again ------------------------------------------------
// A CLI that hits its plan wall usually says when the wall lifts. Parsing it turns a blind retry
// ladder (60 redelivery turns on codex, 09-02) into one wait.
const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
const RESET_ABS_RE = new RegExp(
  String.raw`try again (?:at|on|after)\s+((?:${MONTHS})[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4},?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?)`,
  "i",
);
const RESET_REL_RE = /try again in\s+(\d+)\s*(second|minute|hour|day)s?/i;

/// The epoch ms at which this seat may be retried, or 0 when the output named no time.
export function parseResetAt(text, now = Date.now()) {
  const s = String(text || "");

  const abs = RESET_ABS_RE.exec(s);
  if (abs) {
    // "Sep 3rd, 2026 3:34 AM" — Date.parse rejects the ordinal suffix, so drop it.
    const t = Date.parse(abs[1].replace(/(\d{1,2})(st|nd|rd|th)/i, "$1"));
    if (Number.isFinite(t) && t > now) return t;
  }

  const rel = RESET_REL_RE.exec(s);
  if (rel) {
    const unit = { second: 1e3, minute: 60e3, hour: 3600e3, day: 86400e3 }[rel[2].toLowerCase()];
    if (unit) return now + Number(rel[1]) * unit;
  }

  return 0;
}

/// #6131: a qwen seat whose token plan is spent does not error — it stalls and returns nothing, so
/// the runner classified it `empty-output` and kept the ladder running against a wall. A silent
/// turn on a seat whose own balance row reads spent IS exhaustion, and parks like one.
export function quotaSpent(rows) {
  return (Array.isArray(rows) ? rows : []).some((r) => {
    if (!r || !r.ok) return false;
    if (r.kind === "quota") return r.remainingPct != null && r.remainingPct <= 0;
    if (r.kind === "windows") {
      return (r.windows || []).some((w) => w.locked || (w.usedPct != null && w.usedPct >= 100));
    }
    return r.remaining != null && r.remaining <= 0;
  });
}

/// The failure reason a turn should be treated as, given what the seat's balances say. Only
/// `empty-output` is ever re-read this way: every other reason already carries its own evidence.
export function reasonWithBalances(reason, rows) {
  return reason === "empty-output" && quotaSpent(rows) ? "exhausted" : reason;
}

/// Seats that park rather than retry. A backend error is the provider having a bad minute and the
/// ladder is exactly right for it; a spent plan or a rejected key will not fix itself on a timer.
export const PARKING_REASONS = new Set(["exhausted", "auth"]);

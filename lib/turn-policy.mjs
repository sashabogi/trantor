// Per-turn policy for a crew seat (#6134): is a bus message worth a CLI turn, which card a turn
// belongs to, what it cost, when an exhausted seat may be woken. Lives here because the runner is a
// self-executing script and cannot be unit-tested. docs/CONTRACT-lib.md.

/// The first card a message cites. A turn belongs to exactly one card, and this is how the runner
/// knows when a wake has moved to a different one.
export const CARD_REF_RE = /#(\d{1,7})(?!\d)/;
const CARD_REF_RE_G = /#(\d{1,7})(?!\d)/g;

/// #7061: a citation that HANDS THE CARD OVER, as opposed to one that merely mentions it: a work
/// order routinely opens with a DONE card. Shape separates the roles; position never did.
/// Deliberately narrow: an assignment verb or label immediately before the id.
const ASSIGN_CARD_RE = new RegExp([
  // a label: "YOUR CARD: #6983", "card #7010", "contract: #7061", "work order — #6897"
  String.raw`\b(?:your\s+card|card|contract|work\s+order|assignment)\s*(?:is\s*)?[:\u2014\u2013-]?\s*#(\d{1,7})(?!\d)`,
  // a verb that hands it over: "take #7061", "take card #6897", "work on #7001", "bounce on #6134"
  String.raw`\b(?:take|work|pick\s+up|resume|start|finish|bounced?)\s+(?:on\s+)?(?:card\s+)?#(\d{1,7})(?!\d)`,
  // the card as the subject of a hand-over: "#7061 is yours", "#7002 is bounced"
  String.raw`#(\d{1,7})(?!\d)\s+(?:is|are)\s+(?:yours|bounced|reopened|back)\b`,
].join("|"), "i");

/// Words that make a direct message an instruction rather than conversation. Deliberately short:
/// the point is to catch a contract that forgot to cite its card, not to parse English.
export const IMPERATIVE_RE = /\b(deliver|fix|bounce|contract|next|resume)\b/i;

export function cardRef(text) {
  const m = CARD_REF_RE.exec(String(text || ""));
  return m ? Number(m[1]) : 0;
}

/// Every card a message cites, in the order it cites them — what the runner uses to tell a wake
/// that names ONE card from one that names several.
export function cardRefs(text) {
  return [...String(text || "").matchAll(CARD_REF_RE_G)].map((m) => Number(m[1]));
}

/// The card this text ASSIGNS, or 0 when it only mentions cards. Leftmost assignment wins: an
/// order says what it wants first and explains itself after.
export function assignedCardRef(text) {
  const m = ASSIGN_CARD_RE.exec(String(text || ""));
  return m ? Number(m.slice(1).find((g) => g != null)) : 0;
}

/// #7061: the card a wake batch binds to. Messages addressed to THIS seat outrank @mentions, and
/// the NEWEST assignment wins. Only a batch with no assignment-shaped message falls back to the
/// newest message's first citation.
export function wakeCard(messages, { session = "" } = {}) {
  const all = (Array.isArray(messages) ? messages : []).filter(Boolean);
  if (!all.length) return 0;
  const direct = session ? all.filter((m) => m.to === session) : [];
  const pool = newestLast(direct.length ? direct : all);
  for (let i = pool.length - 1; i >= 0; i--) {
    const c = assignedCardRef(pool[i].text);
    if (c) return c;
  }
  for (let i = pool.length - 1; i >= 0; i--) {
    const c = cardRef(pool[i].text);
    if (c) return c;
  }
  // A batch whose only citation sits in an @mention still names a card; nothing is worse than 0.
  return all.map((m) => cardRef(m.text)).find(Boolean) || 0;
}

/// Chronological order, by whichever field EVERY message in the batch actually has. Mixing hub ids
/// with wall-clock ts across messages would sort by two different scales and silently misorder, so
/// a batch that is not uniform keeps the order the runner queued it in.
function newestLast(msgs) {
  for (const key of ["id", "ts"]) {
    if (msgs.every((m) => Number.isFinite(Number(m?.[key])))) {
      return msgs.map((m, i) => ({ m, i }))
        .sort((a, b) => (Number(a.m[key]) - Number(b.m[key])) || (a.i - b.i))
        .map((x) => x.m);
    }
  }
  return msgs;
}

/// Turn kinds that exist BEFORE or WITHOUT a wake message. Neither can carry a card, so neither
/// can ever be a state step. That is a fact about the SHAPE of the turn, not about configuration,
/// which is exactly why no amount of correct config makes it come out differently.
const NO_CARD_TURNS = {
  kickoff: "a kickoff runs before any message arrives, so it belongs to no card",
  pulse: "a pulse is a timer rather than a message, so it belongs to no card",
};

/// #7060: why THIS turn is not assembled from a WorkingState, or null when it is. The boot line
/// proves CONFIGURATION only; a kickoff belongs to no card and can never be a state step, so the
/// runner asks this every turn and prints the answer (a skip must not read as proof).
/// Reasons are ordered by which constraint actually BINDS.
export function stateSkipReason({ mode = false, kind = "wake", breakerTripped = false, card = 0 } = {}) {
  if (!mode) return "state mode is off for this seat";
  const structural = NO_CARD_TURNS[String(kind)];
  if (structural) return structural;
  if (breakerTripped) return "the state-mode breaker tripped earlier this run, so the seat is back on the transcript path";
  if (!(Number(card) > 0)) return "this wake assigns no card, and a state turn is bound to exactly one";
  return null;
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

/// #6131: when the seat said nothing, its balance row is the only place the reset time exists —
/// `parseResetAt` had no output to read. The EARLIEST spent row wins, because the seat is usable
/// again the moment the first of its walls lifts. 0 when no spent row named a time.
export function quotaResetAt(rows, now = Date.now()) {
  const times = (Array.isArray(rows) ? rows : []).flatMap((r) => {
    if (!r || !r.ok) return [];
    if (r.kind === "quota") return r.remainingPct != null && r.remainingPct <= 0 ? [r.resetTime] : [];
    if (r.kind === "windows") {
      return (r.windows || []).filter((w) => w.locked || (w.usedPct != null && w.usedPct >= 100)).map((w) => w.resetsAt);
    }
    return [];
  }).map((t) => (Number.isFinite(t) ? t : Date.parse(t))).filter((t) => Number.isFinite(t) && t > now);
  return times.length ? Math.min(...times) : 0;
}

/// Seats that park rather than retry. A backend error is the provider having a bad minute and the
/// ladder is exactly right for it; a spent plan or a rejected key will not fix itself on a timer.
export const PARKING_REASONS = new Set(["exhausted", "auth"]);

/// #6228: the sender's home project, by the same "name suffix after the last colon" convention
/// every crew/orch identity is minted with (isRunnerSession in crew-runner.mjs uses the mirror
/// check). A session id with no colon (a bare human alias) has no home project to fence.
export function senderProjectOf(session) {
  const s = String(session || "");
  return s.includes(":") ? s.slice(s.lastIndexOf(":") + 1) : "";
}

/// #6228: may a wake from `senderProject` reach a seat in `seatProject`? Same project always; a
/// declared `trantor policy link` opens the door; anything else is dropped, never worked (the
/// runner's half of the guard the hub enforces at write time).
export function isLinkedProject(senderProject, seatProject, links) {
  if (!senderProject || !seatProject || senderProject === seatProject) return true;
  return (Array.isArray(links) ? links : []).some((l) => {
    const ps = (l?.projects || []).map((p) => String(p || "").toLowerCase());
    return ps.includes(String(senderProject).toLowerCase()) && ps.includes(String(seatProject).toLowerCase());
  });
}

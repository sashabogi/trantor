// Drill Mode (#6800) — the DOM probes that can pre-fill a verdict. Each reads the LIVE app
// document for the exact elements the card's fix mounts (the same hooks the unit suites assert
// on: SuggestionChips' data-testid, Chat's jump-to-latest aria-label, the composer's gauge and
// Aa control, wakeRow's pending line) and says what it saw. A probe never moves a card: the
// operator still presses Pass. Pure over a Document, so the tests hand it a happy-dom tree.
import { WAKE_PENDING_LINE } from "../genesis/wakeRow";
import type { AutoCheckKind, AutoCheckResult } from "./drillSteps";

const CHIPS = '[data-testid="suggestion-chips"]';
const CHIPS_LEAD_IN = '[data-testid="suggestion-lead-in"]';
const JUMP_ARROW = 'button[aria-label^="Jump to latest"]';
const FONT_MENU = 'button[title="Chat text size"]';
const ASK_CARD = '[data-testid="ask-card"]';
/** The question asks.rs makes the drill session ask, and the header it gives it. */
const ASK_DRILL_QUESTION = "TRANTOR ASK DRILL";
const ASK_DRILL_HEADER = "Drill";

function isDrillAskCard(card: Element): boolean {
  if (card.textContent?.includes(ASK_DRILL_QUESTION)) return true;
  for (const span of card.querySelectorAll("span")) {
    if (span.textContent?.trim() === ASK_DRILL_HEADER) return true;
  }
  return false;
}

/** The gauge has no test id of its own (Composer.tsx is another seat's file this week); it is
 *  the element whose leading label reads "context". */
function contextGauge(doc: Document): Element | null {
  for (const span of doc.querySelectorAll("span")) {
    if (span.textContent?.trim() === "context" && span.parentElement) return span.parentElement;
  }
  return null;
}

type Rect = { left: number; top: number; right: number; bottom: number };

export function rectsOverlap(a: Rect, b: Rect): boolean {
  const empty = (r: Rect) => r.right <= r.left || r.bottom <= r.top;
  if (empty(a) || empty(b)) return false;
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

export function runAutoCheck(kind: AutoCheckKind, doc: Document): AutoCheckResult {
  switch (kind) {
    case "chips-mounted": {
      const row = doc.querySelector(CHIPS);
      if (!row) return { ok: false, why: "no suggestion-chips row in the document" };
      const chips = row.querySelectorAll("button.tr-chip").length;
      return chips > 0
        ? { ok: true, why: `chip row mounted with ${chips} chip(s)` }
        : { ok: false, why: "chip row mounted but holds no chips" };
    }
    case "chips-lead-in": {
      const lead = doc.querySelector(CHIPS_LEAD_IN)?.textContent?.trim() ?? "";
      if (!lead) return { ok: false, why: "no chip row lead-in in the document" };
      return lead === "suggested"
        ? { ok: false, why: "lead-in still reads 'suggested', not the question" }
        : { ok: true, why: `lead-in reads '${lead.slice(0, 60)}'` };
    }
    case "jump-arrow-mounted": {
      const arrow = doc.querySelector(JUMP_ARROW);
      if (!arrow) return { ok: false, why: "no jump-to-latest arrow (scroll up first)" };
      const dot = arrow.querySelector('[data-testid="chat-unseen"]');
      return { ok: true, why: dot ? "jump arrow mounted with the unseen dot" : "jump arrow mounted" };
    }
    case "composer-no-overlap": {
      const aa = doc.querySelector(FONT_MENU);
      const gauge = contextGauge(doc);
      if (!aa || !gauge) return { ok: false, why: `composer row not fully mounted (Aa ${aa ? "yes" : "no"}, gauge ${gauge ? "yes" : "no"})` };
      const a = aa.getBoundingClientRect();
      const g = gauge.getBoundingClientRect();
      return rectsOverlap(a, g)
        ? { ok: false, why: "the context gauge and the Aa control overlap" }
        : { ok: true, why: "gauge and Aa rects are disjoint" };
    }
    case "cli-banner-shown": {
      // AccountsPane's minimum-version banner (#6483): "trantor CLI X is older than this app needs (Y)".
      const seen = (doc.body.textContent ?? "").includes("is older than this app needs");
      return seen
        ? { ok: true, why: "the CLI minimum-version banner is on screen" }
        : { ok: false, why: "no minimum-version banner on screen (open Settings, Accounts with the CLI downgraded)" };
    }
    case "ask-answered": {
      // Chat's AskCard (#6094): open shows the options as buttons, answered shows the recorded
      // choice under the word "answered". The newest drill card is the one this step seeded.
      const cards = [...doc.querySelectorAll(ASK_CARD)].filter(isDrillAskCard);
      const card = cards[cards.length - 1];
      if (!card) return { ok: false, why: "no drill ask card in Chat (seed the ask, then open the drill project's Chat)" };
      if (card.textContent?.includes("answered")) return { ok: true, why: "the drill ask card reads answered" };
      const enabled = [...card.querySelectorAll("button")].filter(b => !b.disabled).length;
      return enabled > 0
        ? { ok: false, why: `the drill ask card is open with ${enabled} enabled button(s); click Continue` }
        : { ok: false, why: "the drill ask card is open but its buttons are disabled (no pane target yet)" };
    }
    case "wake-header-pending": {
      const seen = (doc.body.textContent ?? "").includes(WAKE_PENDING_LINE);
      return seen
        ? { ok: true, why: `header reads '${WAKE_PENDING_LINE}'` }
        : { ok: false, why: "pending line not on screen right now (it shows only during the idle gate)" };
    }
  }
}

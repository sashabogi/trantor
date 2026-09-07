// Suggested-reply chips (#5929) — the pure extractor. The TUI offers a suggested next input;
// the chat offers the same KIND of one-click answers, read strictly from what the orchestrator's
// last turn actually says. Nothing is invented and nothing is sent anywhere: this function turns
// closing sentences into at most three chip labels, or none. The transcript does not record the
// suggestion text itself — only `promptSource: "suggestion_accepted"` when one is taken — so
// adoption is evaluated later by counting those turns against chip clicks, not here.
// #6702 — a chip alone is a reinvented yes/no; the terminal shows what you're saying yes TO. So
// a prose chip carries the closing sentence it was read from: `tooltip` is what the button shows
// on hover, `ask` is what the chip row's lead-in echoes (the two differ for a numbered pick, where
// the tooltip is the option and the ask is the sentence that asked to pick).
export type Suggestion = { text: string; tooltip?: string; ask?: string };

const YES_NO_OPENER =
  /^(should|shall|want|do you want|can|could|may|is|are|would|did|does|have|has)\b/i;

// Rule 2's vocabulary: the words an orchestrator asks to hear back verbatim. "say X or Y" with
// words outside this set is rule 4's either/or; "say the word" matches nothing here on purpose.
const SAY_WORD = /\bsay\s+["'`]?(go|yes|ok|okay|ship|approve|proceed|merge)\b/i;
const WAITS_ON_YOUR_WORD = /\bwaits?\s+(?:on|for)\s+your\s+["'`]?(go|yes|ok|okay)\b/i;
const AFFIRMATIONS = new Set(["yes", "ok", "okay", "approve"]);

/** The closing sentences are where an ask lives; a paragraph of context above it is noise. */
function closingSentences(text: string): string[] {
  return text
    .replace(/`/g, "") // backticks dress words, they are not words
    .split(/(?<=[.?!])\s+/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(-3);
}

export function suggestionsFromTurn(text: string): Suggestion[] {
  if (!text.trim()) return [];
  const closing = closingSentences(text);
  const last = closing[closing.length - 1] ?? "";
  const chips: Suggestion[] = [];
  const push = (s: Suggestion) => {
    if (chips.length < 3 && !chips.some(c => c.text === s.text)) chips.push(s);
  };

  // 1. A trailing push ask — the most common end-of-turn in this codebase's life. It consumes
  //    the final sentence: "should I push?" is a push question, not ALSO a yes/no question.
  const pushAsk = /\bpush\b\s*\?/i.test(last);
  if (pushAsk) push({ text: "push it", tooltip: last, ask: last });

  // 2. "say <word>", the operator's own idiom for "answer with exactly this word". "Say go."
  //    was the original; the orchestrator now confirms in prose too ("Say yes and I ship it.",
  //    "...waits on your yes.", #5993), so the cue reads any closing sentence, and only words
  //    that ARE answers count: "say the word" / "say more" stay silent. A plain affirmation
  //    carries its refusal with it: yes without no would put a thumb on the scale.
  for (const sentence of [...closing].reverse()) {
    const m = sentence.match(SAY_WORD) ?? sentence.match(WAITS_ON_YOUR_WORD);
    if (!m) continue;
    const word = m[1].toLowerCase();
    push({ text: word, tooltip: sentence, ask: sentence });
    if (AFFIRMATIONS.has(word)) push({ text: "no", tooltip: sentence, ask: sentence });
    break;
  }

  // 3. A yes/no question: the final sentence asks one, and it is not already a push ask. (An
  //    open question — "what next?" — is NOT yes/no; inventing chips would put words in the
  //    operator's mouth.)
  if (!pushAsk && last.endsWith("?") && YES_NO_OPENER.test(last)) {
    push({ text: "yes", tooltip: last, ask: last });
    push({ text: "no", tooltip: last, ask: last });
  }

  // 4. "say crashed or survived" — either/or, both words verbatim.
  for (const sentence of closing) {
    const m = sentence.match(/\bsay\s+["'`]?([A-Za-z][\w-]*)["'`]?\s+or\s+["'`]?([A-Za-z][\w-]*)["'`]?\s*[?.!]?$/i);
    if (m) {
      push({ text: m[1].toLowerCase() === "go" ? "go" : m[1], tooltip: sentence, ask: sentence });
      push({ text: m[2].toLowerCase() === "go" ? "go" : m[2], tooltip: sentence, ask: sentence });
      break;
    }
  }

  // 5. A numbered list the message asks to pick from — chips "1", "2"… with the option's first
  //    words as the tooltip (the label stays short; the meaning rides the hover).
  //    The sentence splitter runs "1." lines together with the cue, so the ask is the cue's own
  //    LINE ("Which one?"), not the chunk it landed in.
  const pickSentence = closing.find(s => /\b(pick|choose|which)\b/i.test(s));
  const pickAsk = pickSentence?.split("\n").map(l => l.trim()).filter(l => /\b(pick|choose|which)\b/i.test(l)).pop() ?? pickSentence;
  if (pickAsk) {
    const options: string[] = [];
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
      if (m) options[Number(m[1])] = m[2].trim();
    }
    for (let i = 1; i < options.length && chips.length < 3; i++) {
      const body = options[i];
      if (!body) continue;
      push({ text: String(i), tooltip: body.length > 60 ? `${body.slice(0, 59)}…` : body, ask: pickAsk });
    }
  }

  return chips;
}

/** The bounce rule (#5929): the orchestrator's ask is routinely one turn back — hook-driven
 *  turns like "Nothing to swap." follow the real ask and carry none. Collect from EVERY
 *  orchestrator turn since the operator's last user turn, walking NEWEST first as given,
 *  deduping and capping: the most recent ask leads the row. */
export function suggestionsFromTurns(turnTextsNewestFirst: string[]): Suggestion[] {
  const chips: Suggestion[] = [];
  for (const text of turnTextsNewestFirst) {
    for (const chip of suggestionsFromTurn(text)) {
      if (chips.length >= 3) return chips;
      if (!chips.some(c => c.text === chip.text)) chips.push(chip);
    }
  }
  return chips;
}

/** An AskUserQuestion tool call carries its own closing question as structured options rather
 *  than a sentence to parse — the same "nothing invented" rule applies, so its options ARE the
 *  chips, verbatim, capped at three the same way. Takes the option shape structurally (label +
 *  description) rather than importing streaming.ts's AskQuestion type, so this stays the pure,
 *  transcript-agnostic extractor its neighbors are. */
export function suggestionsFromAskOptions(options: { label: string; description: string }[]): Suggestion[] {
  return options.slice(0, 3).map(o => ({ text: o.label, tooltip: o.description || undefined }));
}

/** The chip row's lead-in (#6702): the ask itself, trimmed, in place of the bare word
 *  "suggested" — so "yes" reads as yes to THIS. Whitespace collapses, and a long sentence is cut
 *  at a word boundary with an ellipsis; the full sentence stays on each chip's hover. */
export const LEAD_IN_MAX = 72;

export function trimAsk(ask: string, max = LEAD_IN_MAX): string {
  const flat = ask.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const atWord = cut.lastIndexOf(" ");
  return `${(atWord > max / 2 ? cut.slice(0, atWord) : cut).trimEnd()}…`;
}

/** The lead-in for a chip row: the first chip's ask, trimmed — null when no chip carries one
 *  (the caller then falls back to "suggested"). Prose chips all carry the same ask, so the first
 *  is the row's. */
export function askLeadIn(suggestions: Suggestion[]): string | null {
  const ask = suggestions.find(s => s.ask)?.ask;
  return ask ? trimAsk(ask) : null;
}

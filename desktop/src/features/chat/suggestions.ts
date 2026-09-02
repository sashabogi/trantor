// Suggested-reply chips (#5929) — the pure extractor. The TUI offers a suggested next input;
// the chat offers the same KIND of one-click answers, read strictly from what the orchestrator's
// last turn actually says. Nothing is invented and nothing is sent anywhere: this function turns
// closing sentences into at most three chip labels, or none. The transcript does not record the
// suggestion text itself — only `promptSource: "suggestion_accepted"` when one is taken — so
// adoption is evaluated later by counting those turns against chip clicks, not here.
export type Suggestion = { text: string; tooltip?: string };

const YES_NO_OPENER =
  /^(should|shall|want|do you want|can|could|may|is|are|would|did|does|have|has)\b/i;

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
  if (pushAsk) push({ text: "push it" });

  // 2. "say go" — the operator's own idiom for "answer with exactly this word".
  if (/\bsay\s+go\b/i.test(last)) push({ text: "go" });

  // 3. A yes/no question: the final sentence asks one, and it is not already a push ask. (An
  //    open question — "what next?" — is NOT yes/no; inventing chips would put words in the
  //    operator's mouth.)
  if (!pushAsk && last.endsWith("?") && YES_NO_OPENER.test(last)) {
    push({ text: "yes" });
    push({ text: "no" });
  }

  // 4. "say crashed or survived" — either/or, both words verbatim.
  for (const sentence of closing) {
    const m = sentence.match(/\bsay\s+["'`]?([A-Za-z][\w-]*)["'`]?\s+or\s+["'`]?([A-Za-z][\w-]*)["'`]?\s*[?.!]?$/i);
    if (m) {
      push({ text: m[1].toLowerCase() === "go" ? "go" : m[1] });
      push({ text: m[2].toLowerCase() === "go" ? "go" : m[2] });
      break;
    }
  }

  // 5. A numbered list the message asks to pick from — chips "1", "2"… with the option's first
  //    words as the tooltip (the label stays short; the meaning rides the hover).
  const asksPick = closing.some(s => /\b(pick|choose|which)\b/i.test(s));
  if (asksPick) {
    const options: string[] = [];
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
      if (m) options[Number(m[1])] = m[2].trim();
    }
    for (let i = 1; i < options.length && chips.length < 3; i++) {
      const body = options[i];
      if (!body) continue;
      push({ text: String(i), tooltip: body.length > 60 ? `${body.slice(0, 59)}…` : body });
    }
  }

  return chips;
}

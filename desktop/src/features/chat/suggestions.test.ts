// The chip extractor's contract (#5929): chips come ONLY from explicit asks in the closing
// sentences, capped at three, and silence when nothing matches. Nothing invented, nothing sent.
import { describe, expect, it } from "vitest";
import { suggestionsFromTurn, suggestionsFromTurns } from "./suggestions";

const texts = (s: ReturnType<typeof suggestionsFromTurn>) => s.map(c => c.text);

describe("suggestionsFromTurn", () => {
  it("a trailing push ask offers 'push it'", () => {
    expect(texts(suggestionsFromTurn("Both fixes are in and verified. Push?"))).toEqual(["push it"]);
    expect(texts(suggestionsFromTurn("Landed on the seat. Should I push?"))).toEqual(["push it"]);
  });

  it("'say go' offers exactly 'go'", () => {
    expect(texts(suggestionsFromTurn("The merge is ready at the boundary. Say go."))).toEqual(["go"]);
  });

  it("a yes/no question offers yes and no", () => {
    const s = suggestionsFromTurn("The seat is mid-turn and the gate is green. Should I merge now?");
    expect(texts(s)).toEqual(["yes", "no"]);
  });

  it("an open question is NOT a yes/no — no invented chips", () => {
    expect(suggestionsFromTurn("What should the pane show while the seat works?")).toEqual([]);
  });

  it("either/or offers both words verbatim", () => {
    expect(texts(suggestionsFromTurn("The drill ends one of two ways — say crashed or survived.")))
      .toEqual(["crashed", "survived"]);
  });

  it("a numbered list the message asks to pick from offers 1..N with tooltips", () => {
    const s = suggestionsFromTurn(
      "Three ways to take this:\n1. Land the tab strip first\n2. Ship the rail behind a flag\n3. Wait for the operator\nWhich do you want?",
    );
    expect(s.map(c => c.text)).toEqual(["1", "2", "3"]);
    expect(s[0].tooltip).toBe("Land the strip-first slice".slice(0, 0) + "Land the tab strip first");
    expect(s[2].tooltip).toBe("Wait for the operator");
  });

  it("caps at three chips", () => {
    const s = suggestionsFromTurn(
      "Options:\n1. one\n2. two\n3. three\n4. four\n5. five\nPick one.",
    );
    expect(s).toHaveLength(3);
  });

  it("chips are deduplicated", () => {
    const s = suggestionsFromTurn("Say go or go? The boundary is here. Say go.");
    const labels = texts(s);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("no explicit ask, no chips", () => {
    expect(suggestionsFromTurn("Merged 04ce7f0 into main; the suite is green and the release is cut.")).toEqual([]);
    expect(suggestionsFromTurn("")).toEqual([]);
  });

  it("reads the CLOSING sentences — an ask quoted in history does not chip", () => {
    // Earlier in the turn someone said "push?" but the closing sentence moved on.
    expect(suggestionsFromTurn("Earlier you asked: push? The answer was yes and it is merged now. All quiet."))
      .toEqual([]);
  });
});

describe("suggestionsFromTurns — the bounce rule (#5929)", () => {
  it("walks back through ask-less hook turns to the last real ask", () => {
    // live case: the real ask ("Push?") is one turn back, behind a hook-driven "Nothing to swap."
    const s = suggestionsFromTurns([
      "Nothing to swap.",
      "Both fixes verified. Push?",
    ]);
    expect(s.map(c => c.text)).toEqual(["push it"]);
  });

  it("the most recent ask leads, deduped, capped at three", () => {
    const s = suggestionsFromTurns([
      "Should I merge now?",            // newest: yes/no
      "Say go when ready.",             // older: go
      "Push?",                          // oldest: push it
    ]);
    expect(s.map(c => c.text)).toEqual(["yes", "no", "go"]);
  });

  it("stops at the operator's own words: no user turns in the input, so the caller does the cutting", () => {
    // the caller (Chat) walks back only until a user turn; this function stays pure over the
    // orchestrator texts it is handed
    expect(suggestionsFromTurns([])).toEqual([]);
  });
});

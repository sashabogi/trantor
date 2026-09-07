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

  it("'say <word>' offers that word, and a plain affirmation brings its refusal (#5993)", () => {
    expect(texts(suggestionsFromTurn("Say yes and I ship it."))).toEqual(["yes", "no"]);
    expect(texts(suggestionsFromTurn("Everything is staged. Say ship when you want it out."))).toEqual(["ship"]);
    expect(texts(suggestionsFromTurn("Say ok and the crew stands down."))).toEqual(["ok", "no"]);
    expect(texts(suggestionsFromTurn("Say approve to release it."))).toEqual(["approve", "no"]);
  });

  it("'waits on your yes' is an ask too (#5993)", () => {
    expect(texts(suggestionsFromTurn("This is a production deploy and waits on your yes."))).toEqual(["yes", "no"]);
    expect(texts(suggestionsFromTurn("The merge is queued and waits for your go."))).toEqual(["go"]);
  });

  it("'say' that is not an ask invents nothing", () => {
    expect(suggestionsFromTurn("Say more about what you saw.")).toEqual([]);
    expect(suggestionsFromTurn("I would say the seeder is fine.")).toEqual([]);
  });

  // #5993 reopen on app 0.3.162: the orchestrator's idle asks read "say the word and it goes in"
  // and "whenever you're at a break, say the word" — no answer word to echo, so rule 2 stayed
  // silent and the operator saw no chips. The imperative confirm chips a lone "yes" that carries
  // its sentence.
  it("a trailing imperative confirm ('say the word', 'let me know') chips yes with the ask", () => {
    expect(suggestionsFromTurn("The patch is staged on the seat. Say the word and it goes in."))
      .toEqual([{ text: "yes", tooltip: "Say the word and it goes in.", ask: "Say the word and it goes in." }]);
    expect(texts(suggestionsFromTurn("Nothing else is owed. Whenever you're at a break, say the word."))).toEqual(["yes"]);
    expect(texts(suggestionsFromTurn("Just say the word and I'll ship it."))).toEqual(["yes"]);
    expect(texts(suggestionsFromTurn("Say the word and I start."))).toEqual(["yes"]);
    expect(texts(suggestionsFromTurn("Both are in testing. Let me know."))).toEqual(["yes"]);
    expect(texts(suggestionsFromTurn("Let me know if you want the drill rerun."))).toEqual(["yes"]);
    expect(texts(suggestionsFromTurn("Give me the go and I merge."))).toEqual(["yes"]);
  });

  it("the imperative confirm yields to a more specific ask and to open questions", () => {
    expect(texts(suggestionsFromTurn("Say the word and I push. Push?"))).toEqual(["push it"]);
    expect(texts(suggestionsFromTurn("Say the word. Should I merge now?"))).toEqual(["yes", "no"]);
    expect(texts(suggestionsFromTurn("Say go when ready, or just say the word."))).toEqual(["go"]);
    expect(suggestionsFromTurn("Let me know what you saw in the drill.")).toEqual([]);
    expect(suggestionsFromTurn("Let me know which one you want.")).toEqual([]);
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

// The crebral-health merge-confirm turns, verbatim from the 2026-09-07 17:01 transcript: the
// operator saw NO chips above the composer on app 0.3.159 (#5993). Two orchestrator turns since
// the operator's last word, newest first: the trailer, then the ship-it ask.
const CREBRAL_SHIP_IT = `The QA gate is closed and the only remaining step is a production deploy, which needs your yes.

**State of \`integration/dashboard-account\`** (5 commits, fast-forwardable onto main at \`33eef59\`):

- \`8849f79\` dashboard strip click opens the appointment in the schedule
- \`9387886\` risk-card inputs in the neuro demo seeder
- \`363aafb\` staff account self-service: My account tab, forgot password, owner reset
- \`5604fcc\` carousel pointer-capture fix so plain clicks reach the link
- \`67d13dd\` seeder anchors the demo week to this week

Evidence from the prior session: vitest 3331 passed, 0 failed; \`npm run build\` exit 0; real-pointer browser checks on the production build for the strip click, My account save and validation errors, neutral forgot-password response, and owner reset on front@ with the demo password restored afterward. Nothing has changed on the branch or on origin since.

**One wrinkle.** The working tree has an uncommitted edit to \`scripts/seed-neuro-demo/seed.mjs\` that is byte-identical to the demo-week hunk already in \`67d13dd\`. Git will refuse the fast-forward while it sits there, so I will restore that one file to HEAD first. Your body-map WIP stays untouched and unstaged.

**On your yes I run:**

\`\`\`
git checkout -- scripts/seed-neuro-demo/seed.mjs
git merge --ff-only integration/dashboard-account
git push origin main
\`\`\`

Vercel then deploys crebral.health. Codex has been told the work is verified and idle. Say yes and I ship it.`;
const CREBRAL_WAITS_ON_YES = `Checked. Every stalled row is addressed to the glm seat, and all of them are stand-down or scope notices for card #6659, which was closed as redundant because its scope shipped on Codex's #6662 (\`363aafb\`). No work is owed by glm and nothing needs reassigning or swapping. Codex is alive and idle with no open contract. The scribe rows are FYI notices that asked for no reply.

The only remaining step is the merge and push to main above, which is a production deploy and waits on your yes.`;

describe("suggestionsFromTurns — the bounce rule (#5929)", () => {
  it("the crebral-health merge-confirm turns chip yes/no (#5993 reopen, app 0.3.159)", () => {
    expect(texts(suggestionsFromTurn(CREBRAL_SHIP_IT))).toEqual(["yes", "no"]);
    expect(texts(suggestionsFromTurn(CREBRAL_WAITS_ON_YES))).toEqual(["yes", "no"]);
    expect(texts(suggestionsFromTurns([CREBRAL_WAITS_ON_YES, CREBRAL_SHIP_IT]))).toEqual(["yes", "no"]);
  });

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

// #6702 — a prose chip carries the sentence it answers, so hovering "yes" explains what it
// confirms, and the row's lead-in echoes that ask (trimmed) instead of the bare word "suggested".
import { askLeadIn, LEAD_IN_MAX, trimAsk } from "./suggestions";

describe("prose chips carry their ask (#6702)", () => {
  it("a yes/no question rides on both chips as tooltip and ask", () => {
    const s = suggestionsFromTurn("Both handoff cards are parked in testing. Want me to verify those handoff cards?");
    expect(s).toEqual([
      { text: "yes", tooltip: "Want me to verify those handoff cards?", ask: "Want me to verify those handoff cards?" },
      { text: "no", tooltip: "Want me to verify those handoff cards?", ask: "Want me to verify those handoff cards?" },
    ]);
  });

  it("a push ask, a 'say <word>' and an either/or each carry their own sentence", () => {
    expect(suggestionsFromTurn("Landed on the seat. Should I push?")[0])
      .toEqual({ text: "push it", tooltip: "Should I push?", ask: "Should I push?" });
    expect(suggestionsFromTurn("Say yes and I ship it."))
      .toEqual([{ text: "yes", tooltip: "Say yes and I ship it.", ask: "Say yes and I ship it." },
        { text: "no", tooltip: "Say yes and I ship it.", ask: "Say yes and I ship it." }]);
    expect(suggestionsFromTurn("Run the drill. Say crashed or survived.").map(c => c.tooltip))
      .toEqual(["Say crashed or survived.", "Say crashed or survived."]);
  });

  it("a numbered pick keeps the option as tooltip and the pick sentence as ask", () => {
    const s = suggestionsFromTurn("Two ways forward:\n1. Land the tab strip first\n2. Ship the dock as is\nWhich one?");
    expect(s[0]).toEqual({ text: "1", tooltip: "Land the tab strip first", ask: "Which one?" });
    expect(s[1].ask).toBe("Which one?");
  });

  it("the bounce rule preserves the ask through suggestionsFromTurns", () => {
    const s = suggestionsFromTurns(["Nothing to swap.", "The gate is green. Should I merge now?"]);
    expect(s.map(c => c.tooltip)).toEqual(["Should I merge now?", "Should I merge now?"]);
  });
});

describe("the lead-in (#6702)", () => {
  it("is the first chip's ask, and null when no chip carries one", () => {
    expect(askLeadIn(suggestionsFromTurn("Want me to verify those handoff cards?"))).toBe("Want me to verify those handoff cards?");
    expect(askLeadIn([])).toBeNull();
    expect(askLeadIn([{ text: "Yes", tooltip: "Ship it" }])).toBeNull();
  });

  it("collapses whitespace and cuts a long ask at a word boundary with an ellipsis", () => {
    expect(trimAsk("Should   I\n merge now?")).toBe("Should I merge now?");
    const long = "Should I merge the handoff chain, the ask sidecar and the chip regression into one release tonight?";
    const t = trimAsk(long);
    expect(t.length).toBeLessThanOrEqual(LEAD_IN_MAX);
    expect(t.endsWith("…")).toBe(true);
    expect(long.startsWith(t.slice(0, -1))).toBe(true);
    expect(t.slice(0, -1).endsWith(" ")).toBe(false);
  });
});

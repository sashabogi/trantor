# P0b — the transport bet, drilled live (2026-08-30)

Verdict: **PHASE 1 IS GO.** Every property the new transport needs, herdr v0.8.2 delivered on a
live drill (scratch project `.salvage-drill`, real Claude agent, pane `w2:p16`, since cleaned up).
Card #5576. This document is the evidence; the fixture values feed Phase 1's cargo drills.

## What was tested and what happened

**1. Multiline whole-message delivery — PASS.**
`herdr agent prompt drill2 "<3 lines with \n and a file path mid-line>" --wait`
Transcript verification (python over the session jsonl): exactly **1** user turn containing the
text, literal `\n` newlines preserved inside the turn, the path intact mid-line, one assistant
reply (`DRILL2-OK`). The entire 0.18.15 bracketed-paste bug class is herdr's solved problem.

**2. `--wait` settles on real lifecycle — PASS.**
Returned `agent_prompted` with `agent_status: idle` after the turn; no polling, no guessing.

**3. Blocked detection on a question UI — PASS.**
Drove the agent into `AskUserQuestion`; `--wait` settled on `agent_status: blocked` — herdr
recognized the dialog.

**4. Prompt into a blocked agent is refused before any bytes — PASS.**
`agent prompt` on the blocked agent → `{"error":{"code":"agent_blocked"}}`, and
`grep -c "this text must never land" <transcript>` → **0**. The esc-esc-esc disaster class
(typing at an agent based on our own idle guess) is structurally gone.

**5. Dialogs are answered by explicit key, not typed text — PASS.**
`herdr agent send-keys drill2 enter` → dialog answered → `agent wait` settled `idle`.

**6. Startup dialogs are handled — PASS (bonus).**
`agent start` into a fresh folder hit CC's trust dialog → returned `agent_not_ready` but kept
the name live for `agent read`/`send-keys`; one `enter` later the agent was `idle`,
`interactive_ready: true`.

**7. `--resume` rides the agent surface — PASS (the takeover/open requirement).**
`herdr agent start drillr --kind claude --pane w2:p16 -- --resume e048794a-…` → `idle`; a
follow-up prompt appended to the SAME session jsonl and the agent recalled the prior turn
(answered `DRILL2-OK` to "what did you reply in drill two"). Same-id resume + continuity proven.

## The discovery that was not on the test list

**A pane split from the orchestrator's pane inherits `CLAUDE_CODE_CHILD_SESSION`, and Claude
Code then runs with TRANSCRIPT SAVING OFF** ("⚠ Transcript saving is off — inherited
CLAUDE_CODE_CHILD_SESSION marker"). The first drill agent produced NO jsonl at all — a session
that a transcript-rendering chat would show as nothing, and that delivery receipts could never
confirm. Very plausibly the mechanism behind past "invisible session" mysteries.

**Binding consequence for Phases 1–2:** every path that starts an agent in a pane
(`trantor open`, takeover, crew spawn, overlap successor) MUST clear `CLAUDE_CODE_CHILD_SESSION`
in the pane's shell before `agent start` (drill-proven fix: `unset CLAUDE_CODE_CHILD_SESSION`
via `pane run`, then start). The §7 drill gains an assertion: the started session's jsonl EXISTS
within seconds of the first prompt.

## Phase 1 design confirmations

- Transport call: `agent.prompt` with wait; outcomes observed live map exactly to the TDD's
  `PromptOutcome`: Delivered (`agent_prompted`+idle) · Blocked (`agent_blocked` error, or a
  `--wait` that settles `blocked`) · NoAgent/NotReady (`agent_not_ready`). `agent_prompt_stalled`
  was not triggered (documented: no lifecycle change within 5s) — mapped as Stalled, retry UI.
- Addressing: unique live agent name or hosting pane id. The orchestrator agent should be
  NAMED at `trantor open` (e.g. `orch-<project>`) so prompts address a name that follows the
  occupant, not a positional pane.
- `send-keys` stays the answer path for dialogs the operator chooses to answer from the UI.

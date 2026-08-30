# Reassembly checklist — where we are

The living progress file for the one-surface salvage. **Update rule:** every session that works
on the salvage updates this file in the same commit as the work, and moves the matching board
card. A checked box carries its evidence (command + result, or doc path). If this file and the
board disagree, this file is wrong — fix it first.

Docs: `SYSTEM-CONTRACT.md` (constitution) · `PRD-one-surface-reassembly.md` (requirements) ·
`TDD-one-surface-reassembly.md` (design). Board cards carry phase tag `salvage`.

Legend: `[ ]` not started · `[~]` in progress (name the session/date) · `[x]` done (evidence).

## Phase 0 — research spikes

- [ ] **P0a** `server.live_handoff` semantics → decision in RESEARCH-herdr-handoff.md
- [ ] **P0b** Live transport drill: `agent start --kind claude` + `agent prompt --wait`
      (multiline · blocked-refusal · `--resume` native args) → RESEARCH-herdr-prompt.md
      **← the Phase 1 go/no-go**
- [ ] **P0c** Orca code-read (conversation binding · diff annotations→prompt · usage footer)
      → RESEARCH-orca.md

## Phase 1 — transport (gate: P0b green)

- [ ] `herdr.rs` adapter with `prompt() -> PromptOutcome`
- [ ] `pane_send` shimmed over it; bracketed-paste wrapper + input-clear branches DELETED
- [ ] Blocked / stalled / no-agent outcomes rendered in the composer
- [ ] Delivery receipts unchanged and still green (queue path preserved)
- [ ] cargo drills green (outcome mapping, arg building — fixtures from P0b)
- [ ] Drill §7 steps 1–2 pass live

## Phase 2 — identity

- [ ] `lib/herdr.mjs` adapter; `sessionstart.mjs` reports session→pane when `HERDR_ENV=1`
- [ ] open / adopt / takeover report at their step; graceful-end calls `pane.release_agent`
- [ ] Resolution order everywhere: herdr report → orch-sessions.txt → picker (never guess)
- [ ] Map rewrites: exactly three writers, each emitting `map.rewrite` bus event
- [ ] Drills green (resolution order cargo drill; claim→report→resolve→release node drill)
- [ ] Drill §7 step 4 (app restart rebind) passes live

## Phase 3 — events

- [ ] `events.subscribe` stream in `herdr.rs` → `agent-status` / `pane-lifecycle` Tauri events
- [ ] `orchestrator_status` 3s poll and seat polls REMOVED; composer gate is an event reducer
- [ ] Reconnect + snapshot re-seed handled (drill: drop the stream, state recovers)
- [ ] vitest reducer drills + cargo re-seed drill green

## Phase 4 — context truth, then the handoff machine

- [ ] **4A** One context algorithm + monotonic guard in `contextUsage()` AND `chat_context()`;
      shared fixtures under `test/fixtures/context/` incl. the recorded 7%-at-88% transcript
      (#5572)
- [ ] **4A** Unknown window → frac null → gauge hidden + auto-baton disarmed visibly (#5503)
- [ ] **4B** `handoff.<state>` bus events emitted per owner; chat renders each transition
- [ ] **4B** Recap gate: handoff consumed only on `handoff.recapped`; stop-hook enforcement;
      app shows "successor has not recapped" until then
- [ ] **4B** ENDED→OPENED per P0a decision; `release_agent` wired in
- [ ] **4B** `baton` dial ask/auto on the same machine
- [ ] State-machine drills + live low-threshold handoff drill green
- [ ] Drill §7 step 3 passes live

## Phase 5 — the drill becomes the ship gate

- [ ] `bin/drill-surface.mjs` (`trantor drill`) implements §7 steps 1–6 with per-step evidence
- [ ] Release path runs it for desktop/chat/handoff/crew diffs and refuses red
- [ ] Version-skew header (hooks/CLI/app) printed; mismatch is a named result
- [ ] Three consecutive green runs on real components

## After the gate (feature work reopens — separate cards, not this salvage)

#5570 balance bar to the Orca standard (feeds on P0c) · #5525 color pass · #5401 persistence ·
#5397 overseer lens · takeover V2/V3 · #5509 W2/W3 remainders.

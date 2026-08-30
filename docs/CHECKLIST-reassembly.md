# Reassembly checklist — where we are

The living progress file for the one-surface salvage. **Update rule:** every session that works
on the salvage updates this file in the same commit as the work, and moves the matching board
card. A checked box carries its evidence (command + result, or doc path). If this file and the
board disagree, this file is wrong — fix it first.

Docs: `SYSTEM-CONTRACT.md` (constitution) · `PRD-one-surface-reassembly.md` (requirements) ·
`TDD-one-surface-reassembly.md` (design). Board cards carry phase tag `salvage`.

Legend: `[ ]` not started · `[~]` in progress (name the session/date) · `[x]` done (evidence).

## Phase 0 — research spikes

- [x] **P0a** (2026-08-30, card #5575) `live_handoff` = SERVER succession (updates/remote-attach),
      not agent succession → ENDED→OPENED stays on signal + `trantor open`. Free findings:
      native agent session restore ≈ #5401 once panes report sessions (Phase 2.1), and ZERO
      herdr integrations installed machine-wide (heuristic-only agent states all along —
      install recommendation pending Sasha's OK). Evidence: RESEARCH-herdr-handoff.md.
- [x] **P0b** Live transport drill (2026-08-30, card #5576): **GO for Phase 1.** All 7 checks
      pass — whole multiline message as ONE user turn (\n preserved), --wait settles on real
      lifecycle, blocked detected on a question UI, prompt-into-blocked refused with ZERO bytes
      landed, dialogs answered by send-keys, startup trust dialog handled, `-- --resume <sid>`
      resumes the same session id with continuity. Evidence: RESEARCH-herdr-prompt.md.
      ⚠ New constraint discovered: split panes inherit CLAUDE_CODE_CHILD_SESSION → transcript
      saving OFF → invisible sessions. Every agent-spawn path must unset it (now a §7 assertion).
- [x] **P0c** (2026-08-30, card #5577) Orca read, path-cited → RESEARCH-orca.md. Binding =
      env identity + managed hooks POSTing session_id/transcript_path (endpoint+spool durability)
      + transcript tailing; adopt hook-reported transcript_path in Phase 2. #5570 unblocked:
      Codex usage IS readable (~/.codex/auth.json → chatgpt.com/backend-api/wham/usage);
      Claude OAuth usage confirmed + Fable-scoped limits + statusline sidechannel vs 429s.

**PHASE 0 COMPLETE (2026-08-30).** Verdict: Phase 1 GO on agent.prompt; handoff stays on
signal+open; integration-install decision with Sasha; Orca patterns folded into Phases 2/5570.

## Phase 1 — transport (gate: P0b green) — SHIPPED app 0.3.54, 2026-08-30 (card #5578)

- [x] `herdr.rs` adapter with `prompt() -> PromptOutcome` — SOCKET transport, not CLI (argv is
      unsafe for arbitrary text: no `--` separator, verified; socket has no quoting layer)
- [x] `pane_send` shimmed over it; bracketed-paste wrapper + `pane_agent_status` DELETED
      (net −59 lines in lib.rs)
- [x] Blocked / starting / stalled / no-agent come back as plain-word composer errors
      (existing setError path renders them; no frontend change needed)
- [x] Delivery receipts unchanged (vitest 167/167; receipt machinery untouched)
- [x] cargo 59/59 incl. 3 new fixture drills built from CAPTURED live responses
- [x] Drill §7 steps 1–2 PASS live end-to-end, ACCEPTED by the operator on installed 0.3.54:
      a 3-paragraph dictated chat message arrived as ONE user turn, newlines preserved
      (transcript-verified). Plus the socket-level leg: blocked prompt refused, zero bytes
      landed. App restart rebind (step 4's shape) also observed after the 0.3.54 relaunch.

**PHASE 1 COMPLETE (2026-08-30, app 0.3.54, card #5578 done).**

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

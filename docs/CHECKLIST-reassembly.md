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

## Phase 2 — identity — SHIPPED CLI 0.18.16 + app 0.3.55, 2026-08-30 (card #5579)

- [x] Session→pane reporting comes FREE from herdr's official claude integration (installed
      by Sasha, v8): it reports at SessionStart, so open/takeover/handoff successors all
      self-report. Measured live BEFORE building: fresh pane agent carried
      `agent_session {kind:id, source:herdr:claude}` matching its real transcript.
      → `lib/herdr.mjs` + our own sessionstart reporter DROPPED — the integration is the
      reporter; ours would be a second writer of the same fact (the exact §4 sin).
- [x] `pane.release_agent` DROPPED with reason: herdr clears the report when the occupant
      exits (observed live in P0b — name and report gone after /exit). Nothing to release.
- [x] Resolution order in the app (`orch_session_id`): pane report → orch-sessions.txt →
      never a guess (picker stays the only guessing surface). Fallback proven live: the
      pre-integration session resolves via the map, binding unbroken.
- [x] Map rewrites: three writers through ONE choke point — adopt stops hand-writing the
      file; `writeOrchSession(project, sid, by)` logs every rewrite with author to
      `orch-sessions.log`. (Bus event deferred to Phase 4, where `handoff.claimed` carries
      the interesting rewrite — noted deviation from the TDD.)
- [x] Drills green: cargo 60/60 (captured `agent.get` fixtures: report present / absent /
      no-agent / non-id kind) · test-handoff 70/70 · tsc clean · vitest 167/167
- [x] Drill §7 step 4 (app restart rebind): proven at the 0.3.54 relaunch; 0.3.55 relaunch
      repeats it with herdr-first resolution live.

**PHASE 2 COMPLETE (2026-08-30). npm publish of 0.18.16 DELIBERATELY HELD (Sasha's call):
its CLI half is diagnostics only (rewrite log, adopt choke point) — it ships in one release
with Phase 4's substantive hook changes (#5572 guard, recap gate), after the drill is green.
The app half (resolution order) is already live in 0.3.55.**

## Phase 3 — events — SHIPPED app 0.3.56, 2026-08-30 (card #5580)

- [x] Per-pane `pane.agent_status_changed` stream in `herdr.rs` (StatusStream + pure decoder)
      → `orch-status` Tauri event, spawned with chat_watch, dies with chat_unwatch.
      DESIGN CORRECTED BY LIVE CAPTURE: global pane.* subscriptions REPLAY history on
      subscribe (35 dead panes arrived in one capture) and pane_updated does NOT fire on
      status transitions → per-pane subscription + reseed, never the global stream. The TDD's
      "one global stream" idea was wrong; reality won.
- [x] `orchestrator_status` 3s poll REMOVED (was a herdr subprocess per tick, forever, per
      open chat) → seed-once + listen. KEPT with reasons: composer's 5s inventory poll
      (process/fs truth, only while locked — not herdr) and the 5s pane-arrival file check
      (only while unhosted).
- [x] Reconnect + re-seed: quiet-tick re-checks pane mapping and re-seeds via agent.get;
      dropped stream reconnects after a nap; herdr-down degrades to one socket attempt/3s,
      zero subprocesses.
- [x] cargo 62/62 (frame decode drills from CAPTURED frames: dotted + underscored spellings,
      wrong-pane, ack, garbage) · tsc clean · vitest 167/167.
- [~] Live acceptance: 0.3.56 installed + relaunched; the visible signal is the composer
      flipping send↔stop the MOMENT a turn starts/ends (previously up to 3s lag), and
      blocked states naming themselves. Operator's eyes confirm on next use.

## Phase 4 — context truth, then the handoff machine — BUILT 2026-08-30 (card #5581);
## app half SHIPPED 0.3.57, CLI half awaits the drill-gated 0.18.16 publish

- [x] **4A** One guard rule, one fixture manifest (`test/fixtures/context/manifest.json`),
      two bindings: Rust `ContextGuard` (folded through merge — single-row poison batches
      cannot lie) + `guardContextTokens` in `contextUsage()`. FORENSICS FIRST: 1,839 usage
      rows across both incident-era transcripts show ZERO real sub-40% drops — the "stub"
      hypothesis on #5572 is unconfirmed; the likelier 7%-at-88% culprit was identity
      misresolution (killed by Phase 2). Guard = insurance; a sustained new level (5 rows)
      re-baselines so a true collapse can never be pinned.
- [x] **4A** Unknown window (#5503): the gauge SHOWS "context ?" + names the disarm in its
      tooltip — never hides. vitest drill on `gaugeUnknownWindow`.
- [x] **4B** The §5 ledger rides the handoff file itself (`states[]`: written→claimed→
      recapped, appended by each owner). Bus events DEFERRED with reason: `/events` is
      read-only, the hub is contract-frozen; the file is the durable record and the app can
      render it in a later wave. ENDED/OPENED as explicit rows also deferred: OPENED≈claimed,
      ENDED is bounded by written→claimed timestamps, herdr clears the agent on exit.
- [x] **4B** The recap net (the 2026-08-30 failure, made impossible): sessionstart stamps the
      successor at claim; EVERY prompt before its first Stop carries the recap reminder
      (prompt-focus, hookSpecificOutput) — including a stale queued message; the first Stop
      records RECAPPED and disarms. App "has not recapped" chip deferred to the app wave.
- [x] **4B** `baton` dial (ask|auto), DEFAULT ask: the heartbeat neither arms nor auto-fires
      unless told to; the banner is the ask; PreCompact stays the at-the-wall backstop.
      ⚠ BEHAVIOR CHANGE at publish time: auto-handoffs stop until `trantor autonomy set
      baton auto` (or per-project).
- [x] Drills: test-handoff 84/84 (ledger + recap net end-to-end through the real hooks as
      subprocesses) · baton-turn-boundary 16/16 (auto chain opts in; ask-default drilled) ·
      cargo 64/64 · vitest 168/168 · tsc clean.
- [ ] Drill §7 step 3 live (forced low-threshold handoff through the machine) — runs as part
      of Phase 5's `trantor drill`, where it belongs.

## Phase 5 — the drill becomes the ship gate

- [ ] `bin/drill-surface.mjs` (`trantor drill`) implements §7 steps 1–6 with per-step evidence
- [ ] Release path runs it for desktop/chat/handoff/crew diffs and refuses red
- [ ] Version-skew header (hooks/CLI/app) printed; mismatch is a named result
- [ ] Three consecutive green runs on real components

## After the gate (feature work reopens — separate cards, not this salvage)

#5570 balance bar to the Orca standard (feeds on P0c) · #5525 color pass · #5401 persistence ·
#5397 overseer lens · takeover V2/V3 · #5509 W2/W3 remainders.

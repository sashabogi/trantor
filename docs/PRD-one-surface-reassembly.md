# PRD — One-Surface Reassembly (the salvage)

Status: AGREED direction (2026-08-30) · Companion docs: `SYSTEM-CONTRACT.md` (the constitution),
`TDD-one-surface-reassembly.md` (how), `CHECKLIST-reassembly.md` (where we are).

## 1. Problem

The 08-27→08-28 one-surface sprint shipped the right surface on the wrong seams. The app became
an actor (hosts the orchestrator session, sends messages, fires handoffs) but rebuilt transport,
identity, lifecycle, and delivery out of keystroke injection, side files, and polling — all of
which the terminal backend (herdr) provides natively. Result: a week of whack-a-mole
(newline-as-Enter, /compact fusion, an input-clear that interrupted live turns, a silent handoff,
a context gauge reading 7% at a real 88%, a successor session that never recapped) and an
operator who cannot trust the surface.

The record layer — hub, bus, board, hooks, costs: the moat — is intact and is not part of this
salvage.

## 2. Users

- **Sasha (now):** directs the orchestrator from the app chat all day; the terminal is a
  fallback, not the primary surface.
- **The teams ICP (next):** "legacy developers burning tokens raw in terminals" — people who
  will never assemble terminal + cmux + dashboards themselves. They get the surface only after
  it stops breaking (this PRD is the precondition for showing Trantor to them).

## 3. Goals

G1. **Chat you can trust.** A message sent from the app arrives as one message, provably, or the
    UI says exactly what happened instead. No silent loss, ever.
G2. **Identity that cannot go stale.** The app always knows which session it is talking to —
    across handoffs, takeovers, adoptions, and app restarts — because the pane itself knows.
G3. **No silent transitions.** Every handoff step is visible in chat; a handoff is not complete
    until the successor has recapped. Structurally, not aspirationally.
G4. **State that arrives, not state that is polled.** Seat and agent states change in the UI
    when herdr says so.
5. **One number for context.** The gauge, the banner, and the baton read the same guarded
    value; an aborted turn can never blind them.

## 4. Non-goals (this salvage)

- No new features. #5570 (Orca-standard balance bar), #5525 (color pass), #5397 (overseer lens),
  W4 (git/file management) resume only after the drill gate is green.
- No changes to the record layer (hub, bus, board schema, cost accounting) beyond the two hook
  touches the TDD names.
- No rewrite: each phase swaps one seam's implementation behind the same UI. The app stays
  usable between phases.
- Not solving cross-machine/remote seats or mobile — later waves, same contract.

## 5. Requirements

### R1 — Transport (Phase 1)
1.1 The composer's send path is herdr `agent prompt --wait` (or its socket equivalent). The
    hand-rolled bracketed-paste wrapper and every input-clearing branch are deleted.
1.2 A send into a blocked agent is refused BEFORE any bytes land; the UI renders "blocked on an
    approval dialog" with the pane one click away.
1.3 A stalled prompt (no lifecycle change) surfaces as a visible failure with retry — never a
    silent drop.
1.4 Delivery truth stays the transcript receipt (a user turn contains the send); the prompt
    result is the fast path, not the verdict.
1.5 Multiline, dictated text, and file paths ride the same call unchanged (the 0.18.15 bug
    class becomes herdr's problem, which it already solves).

### R2 — Identity (Phase 2)
2.1 Every session that starts in a herdr pane reports itself to that pane
    (`pane.report_agent_session`) at SessionStart, and again on adopt/takeover/open.
2.2 Runtime identity resolution order, everywhere: herdr's pane report → `orch-sessions.txt`
    (cold-start fallback) → "newest transcript" only inside the adopt picker, shown to the
    operator, never guessed.
2.3 `orch-sessions.txt` has exactly three writers (SessionStart claim, adopt, takeover); every
    rewrite is a bus event.
2.4 After any handoff or takeover, the chat rebinds without operator action; a bound chat
    survives app restart (G2's acceptance).

### R3 — Events (Phase 3)
3.1 The app consumes `events.subscribe` for agent/pane/workspace state; the `orchestrator_status`
    and seat polls are removed.
3.2 The chat transcript tail remains a file tail (that part was always correct).
3.3 Composer enable/disable follows herdr lifecycle events (`idle`/`working`/`blocked`),
    within one event round-trip, not up to 3s of poll lag.

### R4 — Context truth (#5572, #5503 — precondition to Phase 4)
4.1 One algorithm computes context %, with a monotonic guard: an aborted-turn usage stub can
    never lower the reading. Both the Rust gauge and the hook baton pass shared fixture drills,
    including the recorded 7%-at-88% transcript.
4.2 An unknown context window renders as absent and disarms auto-handoff visibly — never a
    wrong number (the fable case, #5503).

### R5 — Handoff (Phase 4)
5.1 The lifecycle is the SYSTEM-CONTRACT §5 state machine: ARMED → OFFERED → WRITTEN → ENDED →
    OPENED → CLAIMED → REBOUND → RECAPPED. Every transition emits a bus event and a visible
    chat artifact.
5.2 A handoff is consumed ONLY when the successor's recap turn exists in its transcript;
    otherwise it is re-presented and the app shows "successor has not recapped".
5.3 The `baton` autonomy dial (`ask`/`auto`) changes who pulls the trigger, never what is
    visible.
5.4 The predecessor is always ended by process signal via herdr — never by keystrokes.

### R6 — The drill gate (Phase 5)
6.1 A scripted end-to-end drill (SYSTEM-CONTRACT §7: cold start → send → handoff → recap →
    app restart → takeover → version-skew check) exists as a runnable command.
6.2 It runs before every release touching desktop/chat/handoff/crew code, and the release
    script refuses to ship on a red drill.
6.3 Version skew (hooks vs CLI vs app) is printed at drill start; a mismatch is a named
    failure, not a surprise discovered later.

## 6. Success metrics

- The drill passes green three consecutive runs on real components (no mocks at the seams).
- Seven days of daily use with zero occurrences of: a lost/fragmented message, a stale chat
  binding, a silent handoff, an unrecapped successor, a lying gauge.
- Polling loops against herdr in the app: 0 (from 4).
- Keystroke paths to an agent: 0 (from 1) outside the human terminal view and explicit
  send-keys UI actions.

## 7. Risks

- **herdr dependency deepens.** Accepted deliberately: herdr owns terminals; Trantor owns
  coordination and the record (the moat is untouched by this bet). Mitigation: every herdr
  call goes through one adapter each in Rust and in the CLI, so a future backend swap is a
  bounded rewrite, and P0's live drill validates the bet for ~an hour of work before any code.
- **`server.live_handoff` may not fit our handoff semantics.** P0a decides; the signal+open
  chain remains the fallback and is already proven.
- **Claude Code TUI changes could break herdr's agent detection.** herdr ships remotely
  refreshed agent manifests; the drill's step 1 catches a detection break immediately.
- **Scope creep during phases 1–4.** The contract's rule stands: feature requests go to the
  board, not the tree.

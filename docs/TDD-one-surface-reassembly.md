# TDD — One-Surface Reassembly

Status: design for the AGREED salvage (2026-08-30). Requirements: `PRD-one-surface-reassembly.md`.
Constitution: `SYSTEM-CONTRACT.md` (ownership table §4, state machine §5, drill §7).
Progress: `CHECKLIST-reassembly.md` + board cards (phase tag `salvage`).

Verified ground truth this design stands on (checked live 2026-08-30, not from memory):
- herdr v0.8.2, protocol 20, socket `~/.config/herdr/herdr.sock`, 196 schema methods including
  `agent.prompt`, `agent.wait`, `agent.read`, `pane.report_agent_session`, `pane.release_agent`,
  `events.subscribe`, `pane.wait_for_output`, `server.live_handoff`, `worktree.*`.
- `agent prompt` semantics (from `herdr --skill`): honors the pane's live bracketed-paste mode,
  encoded Enter after a short delay, refuses a blocked agent with `agent_blocked` before sending
  any bytes, returns `agent_prompt_stalled` when no lifecycle change is observed within 5s;
  `--wait` returns on the first settled `idle`/`done`/`blocked`.
- Context % is computed TWICE today: `hooks/lib/handoff.mjs:41 contextUsage()` (consumed by
  `hooks/heartbeat.mjs:70` to arm the baton and `hooks/precompact.mjs:37`) and the Rust
  `chat_context()` in `desktop/src-tauri/src/lib.rs` (the gauge). This duality is #5572's root.
- Identity resolution today: `orch_session_id()` (lib.rs ~:513) reads `orch-sessions.txt` only;
  the chat watcher (`spawn_chat_watcher`, lib.rs ~:1216) re-polls it every 300ms and emits
  `chat-session-changed`; the frontend handler (Chat.tsx ~:322) resets and resyncs. This chain
  self-heals — the sprint's failures were upstream of it (the map file going stale/being
  rewritten by the wrong actor).

## 0. Architecture decision

**herdr is promoted from "pty host" to "agent runtime authority".** The app and CLI stop
re-deriving what herdr already knows (who is in the pane, what state they are in, whether a
prompt landed) and consume it. Two adapters concentrate every herdr interaction:

- **Rust**: `desktop/src-tauri/src/herdr.rs` (new module) — socket client for the JSON API
  (queries, `agent.prompt`, `events.subscribe`). All existing shelling-out to the `herdr`
  binary migrates here over phases 1–3; nothing outside this module speaks herdr.
- **CLI/hooks**: `lib/herdr.mjs` (new) — thin wrapper over the `herdr` CLI (JSON out), used by
  hooks/sessionstart.mjs, bin/open, bin/adopt.mjs, bin/takeover.mjs, bin/crew.sh (which already
  shells herdr; its call sites migrate opportunistically, not big-bang).

Everything below rides these two adapters. Bounded blast radius if the backend ever changes.

## Phase 0 — research spikes (no product code)

**P0a — `server.live_handoff` semantics.** Read herdr docs/source (`https://herdr.dev/llms.txt`,
repo). Deliverable: a paragraph in RESEARCH-herdr-handoff.md answering: does it transfer a pane's
process/session between servers/clients, or replace the pane occupant? Does it fit §5
ENDED→OPENED? Decision recorded; fallback (signal + `trantor open`) already proven.

**P0b — the transport bet, drilled live.** On a scratch project:
`herdr pane split … && herdr agent start scratch --kind claude --pane <id>` →
`herdr agent prompt scratch "<multiline text with \n and an image path>" --wait` →
verify: one user turn in the transcript containing the exact text; lifecycle went
working→idle; a permission dialog produces `blocked` and prompt refusal (`agent_blocked`);
`agent read` shows the turn. Also probe: does `agent start --kind claude` accept
`-- --resume <sid>` native args (needed for takeover/open under the agent surface)?
Deliverable: RESEARCH-herdr-prompt.md with the exact commands + outputs. **This validates or
kills Phase 1 before any code.**

**P0c — Orca code-read (MIT).** Targets, in priority order: (1) how a conversation view binds
to an agent process and survives restarts; (2) inline diff annotations → agent prompt round-trip;
(3) the usage footer implementation (feeds #5570 directly, including the Codex 61%/25% numbers
Orca demonstrably reads). Deliverable: RESEARCH-orca.md.

## Phase 1 — transport (R1)

**Now:** `pane_send` (lib.rs ~:1413) wraps text in bracketed paste and writes keystrokes at the
pane; delivery receipts reconstruct arrival from the transcript.

**Target:**
1. `herdr.rs::prompt(pane_or_agent, text) -> PromptOutcome` calling `agent.prompt` with wait;
   `PromptOutcome = Delivered | Blocked{ui} | Stalled | NoAgent`.
2. `pane_send` becomes a shim over it (same Tauri command name — the frontend contract is
   unchanged this phase) and DELETES: the bracketed-paste wrapper, all input-clearing branches,
   the idle-evidence guesswork. The composer's queue path stays: a send during `working` queues
   exactly as today (herdr accepts prompts to a working agent; the 5s-stall rule tracks
   lifecycle, so mid-turn queuing is preserved — P0b confirms).
3. Error mapping to the UI: `Blocked` → "waiting on an approval in the terminal" + open-pane
   action; `Stalled` → visible failure with retry; `NoAgent` → the existing takeover affordance.
4. Delivery receipts (transcript containment) UNCHANGED — they remain the truth (R1.4); the
   prompt outcome only upgrades the UI's fast-path states.
5. The human terminal view (xterm in Workspace/tray) keeps raw input — that is a human typing,
   the one legitimate keystroke path. `agent send-keys` remains for explicit key actions (esc,
   ctrl+c) the operator chooses in the UI.

**Out:** `pane_send`'s keystroke body, esc handling, paste wrapping — net-negative diff.
**Tests:** cargo drills for outcome mapping + arg building (fixtures from P0b's real outputs);
the P0b script becomes `test-transport-live.sh` (manual/drill tier, not CI).

## Phase 2 — identity (R2)

1. **Report at birth:** `hooks/sessionstart.mjs` — when `HERDR_ENV=1` and `HERDR_PANE_ID` is
   set, call `lib/herdr.mjs::reportAgentSession(paneId, sessionId)` (exact CLI verb confirmed
   in P0; schema method `pane.report_agent_session`). Also on the claim path when a successor
   claims the baton. `bin/adopt.mjs`, `bin/takeover.mjs`, `trantor open` report at their step.
2. **Resolve in order:** `herdr.rs::orch_session(project)`: (a) the orch pane's reported agent
   session (via `pane.get`/session snapshot), (b) `orch-sessions.txt`, (c) nothing — the adopt
   picker shows candidates (never guesses). `orch_session_id()` callers migrate to this;
   the chat watcher's 300ms re-check now watches the herdr report first, so a handoff rebinds
   even if the map write lags.
3. **Three writers, logged:** map rewrites happen only in sessionstart-claim / adopt / takeover,
   each emitting a `map.rewrite` bus event `{project, from, to, by}`. `bin/crew.sh`'s writer
   comment (single-writer doctrine) updates to name all three.
4. **Release on exit:** the graceful-end path (`handoff_now`, takeover) calls
   `pane.release_agent` after SIGTERM completes, so a dead claimant can never look alive.

**Tests:** cargo drills for resolution order (report beats file, file beats nothing);
node drill in test-handoff.mjs: claim → report → resolve → release → resolve falls back to file.

## Phase 3 — events (R3)

1. `herdr.rs::subscribe(window)` — one task holding an `events.subscribe` stream; emits Tauri
   events: `agent-status` (pane, `idle|working|blocked|done|unknown`), `pane-lifecycle`
   (created/closed/exited). Reconnect with backoff; on reconnect, one snapshot query re-seeds
   state (`session.snapshot`).
2. Remove: the `orchestrator_status` 3s poll (Chat.tsx ~:352), seat-state polls in the fleet/
   workspace views. The composer gate becomes a pure reducer over `agent-status` events.
3. Keep: the 300ms transcript tail (file growth is not a herdr event) and the balances 5-minute
   refresh (different owner).

**Tests:** vitest reducer drills (status event → composer state, incl. `blocked`); cargo drill
for snapshot re-seed after a dropped stream.

## Phase 4 — context truth, then the handoff machine (R4, R5)

**4A — #5572/#5503 first (the trigger must not lie):**
1. One algorithm, two thin bindings: extract the usage-row walk into a specified rule —
   context = usage of the LAST assistant row whose token sum is not a collapse artifact.
   Guard: within a session, track running max; a row < 40% of running max is an aborted-turn
   stub → skipped (the recorded 7%-at-88% transcript is the fixture that must pass; threshold
   tuned against it and a normal post-compaction transcript, which legitimately drops — the
   guard applies within a session id, and compaction mints a new session file, so the two
   cases are separable).
2. Implement in `hooks/lib/handoff.mjs::contextUsage()` and Rust `chat_context()`; BOTH run the
   same JSON fixture suite (fixtures under `test/fixtures/context/`, consumed by node drill and
   cargo drill) so the implementations cannot drift silently.
3. #5503: unknown `contextWindow` (fable) → `frac: null` → gauge hidden, auto-baton DISARMED
   with a visible chat notice ("context window unknown — auto-handoff off"); window values come
   from config/capabilities, never a guessed default.

**4B — the state machine:**
1. States live as bus events `handoff.<state>` (armed/offered/written/ended/opened/claimed/
   rebound/recapped) emitted by the component that owns each step (heartbeat arms; app/CLI
   offer+write; herdr adapter ends; open claims; watcher rebinds; sessionstart+stop enforce
   recap). The chat renders each as its quiet divider — the visibility requirement is satisfied
   by rendering the events, not by per-step UI code.
2. **Recap enforcement (5.2):** the handoff JSON gains `recap_required: true` + `consumed_by`.
   `sessionstart.mjs` injects it with the pinned 3-sentence instruction and records
   `consumed_by: <sid>` only provisionally; `stop-inbox.mjs` (successor's first Stop) checks the
   transcript for an assistant turn after injection — if none matches the recap shape (first
   assistant message, ≤ N sentences — enforcement is "a first reply exists", not NLP), the stop
   hook blocks idle once with "recap the handoff first". The app shows OPENED→CLAIMED→…
   with "successor has not recapped" until `handoff.recapped` lands.
3. **ENDED→OPENED transport:** per P0a — `server.live_handoff` if it fits, else the proven
   signal chain (`SIGTERM foreground pid → wait ≤5s → SIGKILL → trantor open`), now via the
   adapters with `pane.release_agent` (Phase 2.4).
4. The `baton` dial (`trantor autonomy`): `ask` (default) waits at OFFERED; `auto` proceeds at
   the next turn boundary, banner informs. Same machine, same events, same visibility.
5. #5509's shipped W1 pieces (banner, `handoff_now`, spawn suppression) are REUSED as the
   OFFERED/WRITTEN/ENDED implementations — this phase wraps them in the machine and adds the
   missing states; it does not rebuild them.

**Tests:** node state-machine drill in test-handoff.mjs (every legal transition + the two
illegal ones: silent ENDED, consumed-without-recap); the context fixture suite above; a live
low-threshold handoff drill (RELAY_CONTEXT_WARN_FRAC=0.01 on a scratch project) as part of §7.

## Phase 5 — the drill as ship gate (R6)

`bin/drill-surface.mjs` (new; `trantor drill` subcommand): scripted §7 sequence on a scratch
project + throwaway herdr workspace, real Claude session on a cheap model. Steps assert on
evidence (transcript rows, herdr states, bus events), print PASS/FAIL per step, exit nonzero on
any FAIL. Wire-in: the release path (the same one that bumps/bundles CLI+app) runs it and
refuses to ship red when the diff touches desktop/chat/handoff/crew paths. Version-skew header:
print plugin hook version (installed cache), CLI version, app version; mismatch = named WARN
line at minimum, FAIL when the drill depends on the skewed component.

## Rollout & rollback

Each phase is one PR-sized unit, shipped alone, drill-checked (manually until Phase 5 automates
it). Phase order is dependency order; no phase starts until the previous is green on the drill
steps it affects. Rollback per phase = revert the phase commit; the frontend contract
(`chat-rows`/`chat-session-changed`/Tauri command names) is stable across phases 1–2 by design,
so reverts do not cascade. The record layer is frozen throughout except the named hook touches
(sessionstart/stop in phases 2 and 4B).

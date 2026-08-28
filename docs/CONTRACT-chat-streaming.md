# Contract: live chat streaming (cards #5474 Rust / #5475 UI)

The chat lens must feel alive: rows appear as they land in the transcript, not on whole-file
polls. Claude Code writes COMPLETE JSONL rows during a turn (each tool_use / tool_result / text
block lands as its own row while the turn runs). Row-level liveness is the goal. True
token-by-token streaming is NOT in the transcript — do not attempt it.

## Ownership (no exceptions)
- codex — `desktop/src-tauri/src/**` only (new module ok, register in lib.rs).
- glm — `desktop/src/features/chat/**` only (includes composer; card #5477 folds in here).
- Neither touches the other's tree. Contract changes go through the orchestrator.

## Rust side (codex, #5474)
Commands (names verbatim):
- `chat_watch(project: String) -> u64` — start watching the project's orchestrator transcript;
  idempotent (second call = no second watcher); returns the current line count.
- `chat_unwatch(project: String)` — stop watching. Watchers die with the window.
The transcript path resolves exactly like the existing `orchestrator_chat`: session id from
`orch-sessions.txt` (see `orch_session_id`), file under `~/.claude/projects/<slug>/<sid>.jsonl`.
Watch = poll the file every 300ms for growth (fs-event crates optional, poll is fine); read only
NEW complete lines (buffer a trailing partial line until its newline arrives).

Events emitted on the window:
- `chat-rows` payload:
  `{ project: string, sessionId: string, after: number, turns: ChatTurn[], results: <same map orchestrator_chat returns>, meta: ChatMeta }`
  where `after` = the line offset of the FIRST new row in this batch (cursor continuity), and the
  row decoding REUSES the existing `orchestrator_chat` parsing (same ChatTurn/ChatBlock shapes,
  same harness-injection filtering). Do not invent a second decoder.
- `chat-session-changed` payload `{ project: string, sessionId: string }` — emitted when the
  mapped session id in `orch-sessions.txt` changes between ticks (handoff/adopt). After emitting,
  the watcher follows the NEW transcript from line 0.
Tests: cargo unit tests for the tail-reader (partial-line buffering, cursor continuity, rotation).

## UI side (glm, #5475 + #5477)
- Initial backfill stays on the existing `orchestrator_chat` call (after=0), then `chat_watch` +
  subscribe to `chat-rows` / `chat-session-changed`.
- Append semantics: if a payload's `after` != the local line count, DISCARD it and refetch via
  `orchestrator_chat` (no gaps, no duplicates — cursor mismatch means we missed a batch).
- A turn in progress renders progressively: text rows appear when they land; a tool_use renders
  its folded card immediately and fills in when its tool_result row arrives (existing pairing
  logic).
- `chat-session-changed` → clear the thread, backfill from 0, show a quiet "session continued"
  divider. Never silently interleave two sessions.
- #5477: model/effort pickers + send disabled when there is no live session to talk to
  (`seat_state` says the pane is not running an agent); tooltip says why.
- Tests: vitest for append/cursor-mismatch/session-change reducer logic.

## Definition of done (both)
Own tests green (`cargo test` in src-tauri / `npx vitest run` in desktop) — NOT the full repo
suite (it collides across seats; the orchestrator runs it at integration). Card to `testing`
with the command + counts in the note, then `done` only green.

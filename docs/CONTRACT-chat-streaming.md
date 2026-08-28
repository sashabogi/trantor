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

---

# v2 — wave 2 (2026-08-28): context gauge, bookkeeping dividers, file drop

Ownership this wave is BY FILE TREE, not by feature:
- codex — `desktop/src-tauri/src/**` only.
- glm — `desktop/src/features/chat/**` only.
Neither touches the other's tree. Questions go to the orchestrator, not into the other tree.

## Rust (codex): #5508 usage + #5502 bookkeeping rows

1. `meta` gains `context`: `{ tokens: number|null, window: number, frac: number|null }`.
   `tokens` = the LAST assistant row's usage sum (input_tokens + cache_read_input_tokens +
   cache_creation_input_tokens); null until an assistant row with usage has been seen.
   `window` = `contextWindow` from `~/.agent-bus/config.json` (0 when unset — never guess a
   default; an unknown window renders as absent, not as a wrong number).
   `frac` = tokens/window when both are known, else null.
   Carried in BOTH `orchestrator_chat`'s meta and every `chat-rows` event's meta, so the gauge
   moves live as rows land.
2. Bookkeeping rows stop wearing the user's face (#5502): a `user` entry decodes as
   role `"system"`, blocks `[{ kind: "divider", text: <the raw line> }]` when its string content
   starts with `/` (a slash-command record, e.g. this morning's `/compact`), or is a
   `<local-command-caveat>`/`<local-command-stdout>` block, or the entry carries `isMeta: true`.
   Real user speech must NEVER become a divider — the gate is those exact shapes, no heuristics
   on length or content. Note `/compact <fused words>` keeps the WHOLE line as the divider text:
   eaten words stay readable.
3. cargo tests for both: usage extraction (incl. no-usage-yet → null) and each divider gate
   (slash record, caveat block, isMeta, and a plain user message that must stay a user turn).

## UI (glm): #5507 drop + #5508 gauge + #5502 divider

1. `streaming.ts` types widen: `Turn.role` adds `"system"`, `Block.kind` adds `"divider"`;
   `Meta` gains `context: { tokens: number | null; window: number; frac: number | null }`.
   (You own this file; codex conforms to these exact field names.)
2. Gauge: a slim bar in the chat header. Hidden while `frac` is null. Neutral < 0.75, amber
   ≥ 0.75, red ≥ 0.90. Tooltip "489k / 1000k (49%)". No animation needed, just truth.
3. A `system`/`divider` turn renders as a centered, quiet, small mono line — never a bubble.
4. Drop (#5507): dropping files anywhere on the chat inserts each absolute path plus a trailing
   space into the draft at the cursor (exactly like @-accept). Use Tauri v2's webview drag-drop
   events (`getCurrentWebview().onDragDropEvent`) — Tauri intercepts native HTML5 drops by
   default, so do NOT rely on ondrop. If it turns out `dragDropEnabled` must change in
   tauri.conf.json, STOP and tell the orchestrator — that file is not yours.
5. vitest drills: divider rendering stays out of user bubbles; gauge thresholds; drop-insert
   at cursor (pure helper, same style as the @-accept).

## Definition of done (both)
Own tests green (`cargo test` / `npx vitest run` — full desktop typecheck too: `npx tsc --noEmit`),
card to `testing` with command + counts, `done` only green. The orchestrator integrates.

---

# v3 — wave 3 (2026-08-28 afternoon): chat UX + files column

Ownership BY FILE TREE:
- glm — `desktop/src/features/chat/**` only (#5521 #5522 #5523). May IMPORT from
  features/workspace (the xterm pane component) but never edits outside chat/**. If a hook or
  shared util must change elsewhere, STOP and tell the orchestrator.
- deepseek — `desktop/src/features/files/**` + `desktop/src/app/AppShell.tsx` only (#5524).

Design rules that bind BOTH seats (the Buzz calibration — violations get bounced):
- Calm neutral chrome; color lives in CONTENT and STATUS, never in chrome washes.
- Use the existing primitives (tr-card, tr-chip, tr-seg, tr-input, tr-dot) — no inline invention.
- No fake affordances: a control that does nothing does not ship.
- Every control explains itself: label or tooltip, and a disabled state says WHY.
- Mono only where numbers are compared. Fixed widths over elastic where lists live.

## glm

#5521 chrome honesty:
- The context gauge LEAVES the header and joins the composer bar (next to model/effort): slightly
  wider bar + a visible percentage ("49%"), tinted by tone (neutral/amber/red — the existing
  gaugeTone), tooltip keeps "489k / 1000k". Colorful means the TONE is unmistakable, not a
  rainbow.
- The dock toggle (the mystery square) gets an icon that reads (PanelBottom/PanelRight from
  lucide) + tooltip "Dock chat to bottom/right".
- REMOVE the X. Chat visibility is a labeled toggle where the chat lives, rediscoverable —
  collapsing leaves a visible "Chat" affordance to bring it back. Never a dismissal that
  requires prior knowledge to undo.

#5522 reading comfort:
- Font size control in the composer bar or chat menu: three steps (S/M/L) scaling the chat's
  text sizes via a CSS variable on the chat root (not global). Persist in localStorage.
- A drag handle on the chat panel's inner edge resizes its width (right dock) / height (bottom
  dock), clamped to sane min/max, persisted per dock orientation.

#5523 terminal tray:
- A collapsible tray at the chat's bottom edge ("Terminal" with a chevron) that mounts the SAME
  live xterm pane view the Workspace lens uses (import it; read-only). Collapsed by default,
  state persisted. When open it shares the chat's vertical space (drag divider between them is
  a nice-to-have, not required this pass).
- vitest: reducer/persistence logic drills; tsc clean.

## deepseek

#5524 files column:
- The FILES tree leaves the sidebar. The sidebar keeps ONE labeled row ("Files", lucide
  FolderTree icon) that toggles a SECOND COLUMN rendered between the sidebar and the main
  content: fixed width (~240px), its own scroll, collapsible, state persisted. The tree
  component itself is reused as-is from features/files.
- ACTIVE NOW and PROJECTS return to their full height — nothing inline pushes them down.
- vitest for the toggle/persist logic if a pure helper exists; tsc clean; do not restyle
  unrelated sidebar zones.

## Definition of done (both)
`npx tsc --noEmit` exit 0 + `npx vitest run` all green in YOUR worktree, card to testing with
commands + counts, done only green. The orchestrator integrates, builds, and ships.

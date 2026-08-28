# Design: takeover and visibility (#5495 + #5479)

One design, because both cards are the same question: what is the app's relationship to sessions
it did not spawn? Visibility is READING them; takeover is ADOPTING them. Both stand on one
inventory.

## The physical wall, stated once
macOS will not give one process another process's pty (documented in bin/adopt.mjs), and herdr
cannot adopt an existing pty. So a Terminal session's RAW TERMINAL is unreachable — forever, by
design of the OS. Its CONVERSATION is not: the transcript on disk is complete and live, and the
chat lens already renders any transcript by session id (proven 08-28: the operator's Terminal
session streamed in the app all morning). Visibility therefore means CONVERSATIONS, not ptys —
and the surfaces must say so instead of pretending emptiness.

## The session inventory (new, one source of truth)
Per project, three kinds of session, each with the EVIDENCE that backs it:
1. **pane** — the hosted orchestrator: crew-windows.txt orch row + herdr agent state (live truth).
2. **terminal** — an interactive claude whose cwd is the project dir: pid from pgrep+lsof
   (`local_sessions` machinery), session id from the project's transcript dir — the newest .jsonl
   whose mtime is fresh is the live conversation (the adopt evidence standard: shown, not
   asserted). `activeAgo` = seconds since last transcript write; a session writing seconds ago is
   mid-turn, one quiet for minutes is idle.
3. **seat** — crew-runner processes (existing detection).

Rust command `project_sessions(project)` returns the list; the CLI twin lives in the same helper
`trantor adopt` already uses. No heartbeats, no hub — process + filesystem truth only, the ACTIVE
ruling's doctrine (quiet ≠ dead).

## Visibility (read) — V1 scope
- The Workspace empty state stops lying by omission. Today it says "no crew — trantor up" while
  the operator's own session runs in Terminal. With the inventory it says what IS true:
  "This conversation is running in a Terminal window (pid N, last active Xs ago). The terminal
  itself cannot be mirrored here — but the conversation can: read it in Chat, or take it over."
- The chat lens needs no change for the mapped thread (it already follows orch-sessions.txt).
  V2 extends visibility to non-mapped sessions (a session PICKER when a project has several).

## Takeover (write) — the one-click #5495
CLI-first, exactly like handoff_now: one chain in `trantor takeover [project]`, the app shells
it, so terminal users and the button share one tested implementation.

The chain:
1. Inventory. No terminal session + no pane session → plain `trantor open` (the cold case:
   "Start the orchestrator here").
2. A terminal session exists → the two-claudes-one-transcript rule applies: it must EXIT before
   the pane resumes its id. Gate on idleness: `activeAgo` under ~15s means mid-turn — refuse by
   default ("looks mid-turn — wait for it to finish, or --force"). Idle → SIGTERM the claude pid
   (the same graceful end handoff_now uses for the pane; claude persists per-turn, so an idle
   session loses nothing), wait up to ~8s, KILL only as last resort.
3. `trantor adopt <project> --session <sid>` records the id (existing machinery).
4. `trantor open` resumes it in the pane. The chat follows via the map; the composer's liveness
   gate opens when herdr vouches for the agent.

The app side:
- Rust `takeover_now(project)` shells the CLI chain, staged log back to the UI (handoff_now
  pattern).
- The composer's DISABLED state always carries its one action, derived from the inventory:
  · no session anywhere → [Start the orchestrator here]
  · terminal session, idle → [Continue this conversation in Trantor] (+ "running in Terminal,
    last active Xs ago")
  · terminal session, mid-turn → same button disabled with the reason ("it's mid-turn — the
    takeover waits for a turn boundary"), auto-enabling when activeAgo passes the gate
  · pane exists, agent dead → [Reopen] (= trantor open, existing empty-pane heal)
  A disabled control that explains itself and names its moment — the #5477 doctrine extended to
  the biggest control of all.

## What takeover must NEVER do
- Never SIGTERM a session that wrote its transcript seconds ago without --force (in-flight work).
- Never leave the operator with zero sessions: if `trantor open` fails after the terminal claude
  exited, say exactly that and print the resume command (`claude --resume <sid>`) — the
  conversation is on disk and recoverable by hand.
- Never guess between two candidate transcripts silently: two fresh transcripts in one project →
  show both (id, age, size), newest preselected — the adopt display, one click instead of a flag.

## Build cut
- **V1 (now):** `trantor takeover` CLI + `project_sessions` Rust inventory + composer
  action-button states + Workspace terminal-session empty state.
- **V2:** session picker (multiple conversations per project, read any of them in chat);
  cross-machine inventory via hub presence (remote sessions listed, takeover disabled with the
  reason).
- **V3:** takeover-with-baton: instead of resuming the same id, offer "hand off into the pane" —
  the terminal session writes a handoff first (richer continuity for very long threads near
  their window).

# Contract: the desktop Rust shell (`desktop/src-tauri/src`)

The Tauri side of the app. Card #6450 moved these contracts here from comments; the incidents
behind them live on the cards linked below. Ownership rows are in `docs/SYSTEM-CONTRACT.md` §4.

## Process environment

- `terminal_path()` is the PATH a terminal would have. A Finder-launched app inherits only
  `/usr/bin:/bin:/usr/sbin:/sbin`. Resolution: ask the login shell first (it knows install dirs we
  cannot guess, such as kimi's `~/.kimi-code/bin`), then union the usual roots, then whatever was
  inherited. Order is preserved and duplicates dropped, so the shell's own precedence wins. The
  doctor probes seats with `command -v`, so a bare PATH reports a machine with no crew CLIs.
- Self-update discovers releases the way `bin/app.mjs` does (any release carrying a
  `Trantor_*.dmg` is an app release, newest wins) and runs in-process, needing no CLI on PATH.

## Request signing (`identity.rs`)

Signing lives in Rust so the private key never reaches the webview, and because macOS App
Transport Security blocks cleartext HTTP from WKWebView. Signatures MUST be byte-identical to
`lib/identity.mjs`. The canonical string is a fixed six-field, newline-joined block:

```
trantor-v1
<METHOD>
<PATH+QUERY>
<sha256(body) hex, or "" when there is no body>
<unix ms>
<16 random bytes, hex>
```

Any divergence (field order, trailing newline, hex casing) yields a generic 401. Keys are the
files the CLI and hooks use, `~/.agent-bus/keys/<safe-name>.json`, holding raw 32-byte scalars as
hex; the app only reads them. The SSE stream is parsed by hand for the same reason (EventSource
cannot send auth headers); reconnect uses capped backoff and `since` resumes from the last id.

A project is something you can OPEN: a pinned hub or a checkout on this machine. A positive rule,
never a blocklist on name shapes, because sessions register whatever string they resolved.

## herdr adapter (`herdr.rs`)

- The ONE place the app speaks to herdr's agent surface (§4 "prompt delivery" + "agent
  lifecycle"). Requests are newline-delimited JSON over herdr's local socket, protocol 20, never
  the CLI: composer text is arbitrary and the CLI has no `--` separator. One request per
  connection; the server may interrupt in-flight requests across a live-handoff replacement.
- Operator messages ride `agent.prompt`: herdr owns paste-mode handling, Enter encoding, and
  refuses a blocked agent before any bytes land (drill-proven in `docs/RESEARCH-herdr-prompt.md`).
  Delivery truth is unchanged: the transcript receipt decides what the operator is told.
- Picker answers (AskUserQuestion, permission prompts) ride `pane.send_text` (#6094): the picker
  IS the blocked state `agent.prompt` refuses. `send_text` operates on the terminal, never the
  agent classification, and succeeds against a pane with no recognized agent. A streaming
  `agent attach` client is read-only without an explicit takeover (a second observer must never
  inject into a pane someone else is typing in), so writing through it returns EIO.
- Hot-path queries use a short read budget: a load-slowed herdr held one `agent.get` for the full
  30s default and stalled the transcript tail.
- `reported_session` reads the `agent_session` the agent's own integration reported (source
  `herdr:claude`): the runtime identity authority, correct the moment a successor boots.
- Per-pane status subscription (`pane.agent_status_changed`): the ack line is
  `{"result":{"type":"subscription_started"}}`; frames are
  `{"data":{"agent","agent_status","pane_id","workspace_id"},"event":"pane.agent_status_changed"}`.
  Per-pane subscriptions are live-only; the global `pane.*` types replay history on subscribe,
  which is why the app subscribes per pane and re-seeds via `agent_status()`.

## Orchestrator chat (transcript reading)

- The chat is read from Claude's JSONL transcript; `trantor open` chooses the session id so the
  file is addressable. `after` is a line offset, not a timestamp: the transcript is append-only,
  so the count of lines already seen is the cheapest correct cursor and survives a restart. The
  CLI writes one row per content block, so an in-progress turn is several rows with no `user`
  row until the operator answers (#6094).
- Session id resolution (§4 identity row): the pane's own herdr report first, then
  `orch-sessions.txt` as the durable cold-start map. Never "the newest transcript". The report
  only wins when its transcript exists on disk (an ephemeral run such as a plugin update registers
  a sid with no file). The herdr leg is cached 3s because the watcher polls every 300ms.
- Renderable pieces: `assistant::text/thinking/tool_use`, `user::text/tool_result/image`. A raw
  TUI y/n prompt never reaches the transcript. AskUserQuestion is an ordinary `tool_use` with
  `input.questions[{question, header, multiSelect, options[{label, description}]}]` and is kept as
  `ask`. Tool outcomes are returned separately from turns, keyed by call id, because a result
  usually arrives in a later batch; the front end fills cards in as answers show up.
- Harness injection (hook output, notices, reminders) arrives as user turns and is filtered by a
  closed prefix list, never a length heuristic. A slash command is a first token with one bare
  name; an absolute path has more slashes and is not one.
- `queue-operation` rows: an `enqueue` IS the operator speaking mid-turn (rendered, state
  "queued" until a dequeue marker); `remove` is bookkeeping. Task notifications are enqueued the
  same way and pass the same filter.
- A turn's end is a transcript fact (#5993): a `system` row with subtype `turn_duration`, or the
  stop hook's `stop_hook_summary`. The rows batch re-seeds status once per turn end because the
  pushed stream can freeze on `working`.
- Context gauge poison guard (#5572): within one session real context never collapses (zero drops
  below 40% of the running max across 1,839 usage rows in two incident-era transcripts). One row
  far below the max is an artifact and the recent maximum is reported; five consecutive low rows
  re-baseline the guard. The same rule, from the same fixture manifest, lives in
  `hooks/lib/handoff.mjs` so the baton and the gauge agree.

## Watchers and events

- Status and chat watchers share one stop flag keyed by `project:session`, tagged with a
  generation; an unwatch only fires when the caller's generation matches (#6113).
- `window.emit()` must be called from a `tauri::async_runtime` task. An emit from a raw
  `std::thread` reports ok and never reaches the frontend listener (#5993); background threads
  send payloads over a channel to an async task that owns the emit.
- Balances belong to `lib/balances.mjs` and the local hub snapshot; the app never calls a
  provider. Refresh runs the CLI and re-reads the snapshot.

## Local session truth (ACTIVE / OPEN)

ACTIVE means any registered project with a terminal window open. Heartbeats ride hook fires and
go dark after five quiet minutes, so they only answer "mid-turn right now" (the blink). OPEN
consults process truth on this machine (interactive `claude` windows under the dev root,
crew-runner seats by argv) PLUS herdr for every project with an orch row (#6163): a pane herdr can
still name, in any agent status, counts as open wherever it runs. Each project appears once, and
herdr's status wins over bare process truth.

## Handoff chain (`handoff_now`)

- Entry guard (#6668): the orch pane must exist AND hold a live agent before any step runs. No
  agent means nothing to hand off; the refusal is an `Err` and is traced.
- The pid a graceful end targets comes from `pane process-info` (parity with
  `bin/baton-pane.mjs` foregroundPid). The shell (`shell_pid`, or any foreground entry named like
  one) is never a candidate; a shell-only foreground answers None.
- Boundary record (#6528): the CLI's gate may have ARMED the baton mid-turn instead of writing a
  record. The chain waits (bounded) for the Stop hook's record before the kill.
- Idle gate (#6081): only an in-flight turn ("working"/"busy") holds the gate. Poll on the
  kickoff cadence, bounded by `HANDOFF_IDLE_DEADLINE` (120s: an operator is watching and a typical
  turn ends inside two minutes). A deadline pass still ends the session, and the label names which
  side of the gate the kill happened on. A session parked in `relay_wait` reads "working" for as
  long as the bus is quiet, so for it the deadline IS the gate and "deadline" is the expected
  outcome: the wait is not work, and the boundary record is already on disk.
- The chain marks its project from the first step to the last (`handoff-progress`), so the
  Workspace tab shows the session going away before anyone types into it.

## Kickoff after reopen or wake (`kickoff_after_reopen`)

- A prompt fired straight after `trantor open` returns lands on nobody (#6184, #6139). The ladder:
  wait for the agent to read idle (bounded), send the boot prompt over the herdr socket, retry
  transient outcomes on the kickoff cadence until it lands, is blocked, or the deadline passes.
  The first send always happens. Every herdr call rides `spawn_blocking`; sleeps are tokio's.
- Retry decision per attempt: Delivered and Blocked stop (a human must answer the dialog);
  NotReady, NoAgent and Err retry; Stalled gets exactly one retry.
- Double-kickoff guard (#6201): Stalled means "no lifecycle change observed", not "the send did
  not happen". Before any retry ask the pane; an agent reading working/blocked is mid-turn on our
  prompt and is not retried.
- Wake kickoff only fires when the open actually STARTED a conversation; a reattach is someone's
  live session. `trantor open` resolves the project dir first because it inherits the caller's cwd.
- Real-path check for the Wake button (#6138/#6201), by hand against a live idle pane: `trantor
  new` a throwaway and `trantor open` it; wait for `herdr agent list` to read idle; press Wake on
  the sidebar row; the row reads "kickoff pending" during the gate, then the outcome; expect
  "kickoff sent" and exactly ONE `agent.prompt` in herdr's log.

## Interrupted sessions and persisted UI state

- A project whose orch pane survived while the conversation inside did not (#5401) is offered a
  resume per its baton dial, via `trantor open`. Queried at app LAUNCH only: an `/exit`ed session
  also leaves an agent-less pane, and a poll would nag forever (monitoring doctrine).
- Dismissals persist in `~/.agent-bus/config.json` under `dismissedSessions`, keyed on
  (project, pane handle) so a new dead session for the same project still shows (#6476).
- `onboarding` and `rightPanel` use the same config.json convention. An install with a hub pin
  from before onboarding existed is migrated past the wizard on first read (`closedAt` set then).
  The right panel tab is keyed by project (#6499).
- Tests that repoint `AGENT_BUS_DIR` hold `BUS_DIR_TEST_LOCK` for their whole body and restore the
  prior value: `set_var`/`remove_var` mutate one process-wide environ block non-atomically.

## Editor, files and git

- Save is a file write and nothing else (#5809): no staging, no commit. The seat-working guard
  refuses a human write while the seat is mid-write; herdr is the one owner of that answer.
- `git diff --numstat HEAD` is read once per tree/panel request; untracked and binary rows map to
  nothing rather than a fake zero (#5811).
- Path guard `resolve_within`: reject empty, NUL-containing and absolute inputs, canonicalize
  (follows symlinks), then require a descendant of the canonical root. A missing final component
  is checked by its nearest existing ancestor so unstage works on a deleted file.
- Porcelain v1 `-z`: paths are raw, a rename/copy carries its origin as a second NUL field which
  is consumed, records too short for XY + path are skipped.
- No-upstream is an explicit state: `has_upstream` selects what `ahead` describes (the remote,
  else the merge base with main; `behind` is then None).
- Autonomy dials are read and written through the CLI; the validation whitelist lives in
  `bin/autonomy.mjs` + `lib/autonomy.mjs` and the CLI's error is surfaced verbatim.
- Attachments are paths: a pasted image is written under `~/.agent-bus/attachments/` and spliced
  in like a drop. Chip facts (#6070) return None, not an error, for a non-file.
- Project icons are read from the local repo; monorepo subroots (`apps/web/public`, `web/app`,
  `desktop/src-tauri/icons`) are checked after the top level misses. Null is the normal path.

## Ghost text (`ghost.rs`, #5897, #6160)

- One direct OpenAI-compatible HTTP call from the app process. Config is read at runtime from
  `~/.agent-bus/.env`: qwen preferred (base
  `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`, model `qwen3.8-flash`,
  key `QWEN_API_KEY`, `enable_thinking: false`); deepseek when the qwen key is absent (base
  `https://api.deepseek.com/v1`, model `deepseek-v4-flash`, key `DEEPSEEK_API_KEY`).
- Request shape: `max_tokens` 32 (measured ~200ms faster p50 than 64, p95 under the 2s timeout),
  stop at the first blank line, 2s client timeout so a slow provider degrades to "no ghost".
- Purity split: everything that shapes the request (env parse, provider pick, prompt, body,
  completion parse) is a plain function with a unit test; only the network round-trip lives in
  the command.
- Streaming: the target is time-to-first-line (acceptance: p50 under 600ms on qwen3.8-flash).
  Deltas go to the webview on a request-keyed channel and the HTTP stream is aborted at the first
  complete line. The FIM prompt puts stable bytes first so consecutive keystrokes share a
  cacheable prefix.
- Latency probes (`ghost_latency_matrix`, `ghost_stream_latency`) are `#[ignore]`d: they make real
  calls and spend the provider key.

## Panic reporting and built-app drills

- `install_panic_hook` writes message, location, thread and backtrace to `app-panics.log`
  BEFORE an abort (#5917, #6317): a panic inside AppKit's `sendEvent` cannot unwind and the crash
  report shows only the abort. Tauri has no `catch_unwind`, so every command invoke is caught.
- The vendored tao catches an Objective-C exception at its `sendEvent:` boundary and calls the
  reporter in `key_drill.rs`, which logs name, reason and stack.
- `TRANTOR_PANIC_DRILL=1`: a panic unwinding through a plain `extern "C" fn`, headless, before
  `tauri::Builder`; proves the hook sees the original panic.
- `TRANTOR_ASK_DRILL=<project>`: mounts Chat headlessly on that project's orch pane and drives the
  real blocked path (`src/features/chat/askDrill.ts`), narrating into `app-trace.log`.
  `TRANTOR_ASK_DRILL_WRITE_TARGET=<pane-id>` also proves the write path against a pane the
  operator set up (a throwaway `cat -v` pane), never the real orchestrator.
- `TRANTOR_KEY_DRILL=post`: the frontend (`src/features/workspace/keyDrill.ts`) focuses nothing,
  then the terminal pane, then another textarea, and for each Rust posts a right-arrow
  keyDown/keyUp through `[NSApp postEvent:atStart:]`. `=throw`: the same, and tao raises a real
  NSException inside its guard on the first keyDown. `TRANTOR_KEY_DRILL_PROJECT=<name>` makes the
  main window key and opens that project's Workspace so the terminal pane mounts. Exit 0 when the
  app survived (and in throw mode app-panics.log names the exception), 3 otherwise.
- `TRANTOR_HANDOFF_DRILL=<project>`: the frontend (`src/features/chat/handoffDrill.ts`) opens that
  Chat, watches for a banner and a chain, then invokes `handoff_now` and expects the refusal. The
  verdict reads only this run's `app-trace.log`: no "chain started", a "banner withheld" line, a
  "refused" line. Exit 0 on pass, 3 otherwise.
- Drill Mode (#6800): `drill_screenshot` writes under `<bus dir>/drills/` with the card id as a
  sanitized label; `drill_key_post` and `drill_panics_since` are reachable only from the running
  app's webview. All drills are inert unless their variable is set.

# Contract: the desktop frontend (`desktop/src`)

The rules below used to live as comment essays in the files named; the comment policy (#6450)
keeps one or two lines of why in code and moves the durable rule here. The incident stories
are on the cards cited.

## Hub client (`shared/api/client.ts`, `shared/api/transport-errors.ts`)

- Every view imports `client.ts`; nothing else talks to a hub. Every request goes through the
  Rust transport, never `fetch()`: macOS App Transport Security blocks cleartext HTTP from the
  webview, and the signing key and signature never enter JS. The hub runs `RELAY_AUTH=enforce`
  (`x-trantor-pubkey/-sig/-ts/-nonce`), so `path` MUST include the query string: it is signed.
- SSE is parsed from a streaming fetch in Rust (`EventSource` cannot carry the four headers).
  Frame parsing, reconnect backoff and resume-from-last-id happen in Rust; the webview only
  receives parsed JSON on the `hub-event` listener, and `streamEvents` returns an unsubscribe.
- Economics: the Scrooge ledger (real spend) and card costs are separate from notional
  plan-covered work so a sum never implies we paid for plan tokens. Ledger sections are empty
  on a hub whose machine has no ledger (the remote hub); card costs are populated everywhere.
- Balances, quotas and subscriptions are machine-local (`profile.json`, crew snapshots): always
  ask the LOCAL hub for them, never a remote one.
- An unrecognised transport failure string is shown verbatim, never replaced by a friendly
  generic: the raw reqwest text is what makes a bug report actionable.
- Lookup tables are `as const satisfies Record<...>` and are read through `dictGet` (undefined on
  a miss), never by casting an unclosed hub-sourced string (status, kind) into the key type.

## Chat streaming and status (`features/chat/streaming.ts`, `Chat.tsx`, `statusArbiter.ts`)

Companion to docs/CONTRACT-chat-streaming.md (the wave-by-wave Rust/UI contract).

- Wiring order: backfill once via `orchestrator_chat`, then `chat_watch` and listen for its two
  events; fall back to polling when no watcher is offered. The `orch-status` listener is
  registered, and its registration awaited, BEFORE `chat_watch` is invoked: the Rust watcher can
  emit its first frame within microseconds of returning.
- Cursor rule: a `chat-rows` batch appends only when its `after` equals the folded line count.
  On a mismatch the payload is discarded untouched and the caller refetches; `total` from
  `orchestrator_chat` is the authoritative line count. `after + turns.length` is only a lower
  bound because system rows, harness injections and tool_result lines advance the file without
  a Turn. Two overlapping reads are never merged.
- `sync()` has one fetch in flight globally: a call that arrives mid-flight sets `pending` and
  returns, and completion re-runs it. It may be asked for concurrently by mount, gap checks,
  cursor resync and handoff restart, none of which know about each other.
- `chat_unwatch` is called with a resolved generation only (#6113). The generation-less form
  removes whatever watcher is live for the key, so a stale snapshot would tear down a later
  mount's watcher. Cleanup awaits its own `chat_watch` promise rather than reading a ref.
- Status has two racing sources, a one-shot seed and a stream of pushes. Each carries a `seq`
  stamped at dispatch (seed) or arrival (push), never at promise resolution; `apply()` keeps the
  highest seq seen (#6146). The re-seed schedule is finite and self-cancelling: any real status
  disarms the remaining timers, and all timers clear on unmount or pane switch.
- Every `orch-status` arrival logs its outcome (matched, dead listener, session not alive, parse
  failure, project mismatch). A silent catch is indistinguishable from the event never arriving.
  The payload arrives as a plain object from Tauri; only tests send a string.
- `chat-rows` pushes land before the `orch-status` push that follows them (herdr writes the
  transcript before flipping status); both `applyBackfill` and `applyRows` must render an open
  ask. `decode_chat_lines` emits one Turn per JSONL content-block row, so a backfill arrives as
  consecutive single-block turns.
- AskUserQuestion (#6094): its tool_use is never batched with neighbouring tool calls (ToolRun
  routes only a single-block array to AskCard); answered state comes only from the transcript's
  tool_result, never set on click; a click writes keystrokes into the session's pane via the
  Rust `ask_answer` command (`pane.send_text`), never `agent.prompt` (refuses on a blocked pane)
  and never a `term_attach` client (read-only by design, writes fail with EIO). `openQuestion`
  is status-agnostic; the caller gates rendering on `status === "blocked"` because a result-less
  ask while not blocked is a tool_use/tool_result landing race.
- Picker keystrokes: Down repeated to the target index, then Enter, confirmed from the picker's
  own footer string; Space-to-toggle for multi-select is Ink convention, not yet confirmed live.
- Suggested-reply chips read AskUserQuestion's structured options as well as text blocks
  (#5993). The transcript records only `promptSource: "suggestion_accepted"`, never the chip
  text, so adoption is measured later by counting those turns against chip clicks.
- Liveness is asked of `orchestrator_status` (herdr's agent list), never inferred from a pane
  row existing; `none`/`unknown` are the closed not-live set, any other status means live.
- The handoff offer (banner, countdown, auto-fire) requires a live session behind the pane; a
  context gauge alone reflects the transcript, not whether a session exists (#5509). A failed
  handoff surfaces inline; success is shown by the session-changed divider and composer gate.
  `dismissedAt` stores the gauge fraction at dismissal; re-showing is gated on the fraction
  growing by another step, not on elapsed time.
- Reading size (#5522): the chat root carries `--chat-scale`; text classes over it are literal
  Tailwind strings, never helper-built, because Tailwind's scanner only sees literals.

## Composer, sends and attachments (`features/chat/Composer.tsx`, `attachments.ts`)

- Every composer input is enabled only when the target pane is LIVE (#5477), not merely
  registered, and `liveWhy` names the reason on any locked control. The takeover action
  mirrors the `trantor takeover` CLI chain exactly so the UI never offers what the CLI refuses.
- Model provenance: `reported` (from the transcript) or `dispatched` (sent, unconfirmed). Effort
  and model option lists come from `claude --help`, never typed from memory.
- A send is PENDING until its own project's transcript echoes it back (#5504); its project and
  pane are fixed at send time (#6250) and never re-judged against whatever the composer shows
  now. Delivery is judged by containment, not equality (a fused row is still delivered). One
  mechanical retry fires at the turn boundary; a second failure stays visible with the text
  preserved. `LOST_AFTER_MS` is the grace window.
- Attachments are chips (#6070), never paths in the text area (dictation can splice a word into
  a path, #5773). Chips serialize at send time to the exact wire shapes #5507/#5709 define: one
  chip inline ("path draft"), two or more one path per own line before the prose, no
  "(image N)" markers, zero chips passes the draft through unchanged. Receipts depend on these
  bytes. Trimmed containment covers CC's "[Image: source: <path>]" rewrite; the line-wise
  fallback budgets pathless "[Image #N]" placeholders per turn.
- File drops arrive via Tauri's `onDragDropEvent` (HTML5 `ondrop` never fires in the webview).
  `composerTakesDrop` owns a drop only when the topmost element at the point is inside the
  composer and no modal sheet is open (`data-modal-sheet-open` claims all drops). Pasted images
  are written to `~/.agent-bus/attachments/` by Rust and become chips; paste failures surface in
  the composer's error line.
- Composer drag tracking attaches `pointermove`/`pointerup` to `window` (WKWebView does not
  reliably retarget captured moves). Height measurement collapses to `auto`, then restores the
  measured value in a layout effect; a blank style would strand the textarea at the default.
- The usage gauge is the only element in the dial row that shrinks: bar first, the word below
  76px, the number below 32px; the Aa menu is `shrink-0` after it and is never pushed off-pane
  (#6701). Session-inventory polling for the locked composer runs only while locked.

## Sidebar, projects and activity (`app/AppShell.tsx`, `app/projectActivity.ts`, `shared/presence.ts`)

- The project list comes from `known_projects` only (pinned hubs plus real checkouts), never bus
  traffic; each poll replaces the list, and a failed fetch never shrinks it. A project with no
  routing pin falls back to the local hub by design (TDD §12.1).
- Activity has exactly two truths: OPEN (a live local session process, or a herdr-visible pane
  even with no heartbeat yet, #6163) and BUSY (a hub heartbeat inside the 90s work window, which
  also counts as open). Peers aggregate from the active and local hubs, freshest wins. The
  merge is pure in `projectActivity.ts`. Liveness has one shared definition in `presence.ts`:
  the heartbeat fires on PostToolUse, fresh means calling tools, stale-but-recent means idle at
  the prompt, past the online window means gone.
- The "Active now" group renders only when something is live. Row text: BUSY shows
  "mid-turn · Ns ago · model" (#5610); OPEN with no heartbeat shows herdr's own status;
  "blocked" (#6094) is amber and never blinks.
- Wake: one `trantor open` through the frozen herdr bridge, which reattaches rather than stacks
  and claims any waiting handoff with a fresh session id. One wake at a time; a second click
  mid-open re-asks (#6138). A newly mounted window queries wake progress rather than waiting for
  the next event (#6201). The launch-only reboot-restore check (#5401) and the sidebar share the
  single `wakeProject` path; the baton dial decides auto-resume versus an ask strip.
- The inbox badge and Inbox view read with `peek=1` and never advance the hub delivery cursor:
  that cursor belongs to the receiving session's hooks. Seen ids are tracked locally
  (`shared/seen.ts`); unread = direct messages to me minus seen.
- The search palette (#5625) is one component with two scopes: per-lens trigger (project) and
  ⌘K (global). Results follow the board's own match vocabulary (`match.ts`).

## Board, messages, proposals, notifications

- Board colours match the hex values `bin/crew-runner.mjs` uses in the cmux sidebar. The client
  never offers a shortcut around the `testing` gate (`bin/crew.sh` enforces it). Sub-agents join
  a focus card on `subagent.parent === focus.cc` (the Claude Code session id), never the bus
  session id; a card with no `cc` (pre 0.17.70) falls back to the per-lane roll-up. A collapsed
  roll-up auto-expands when a card inside matches the search. Pace is never a percentage.
- Threads in CardDetail are derived at read time from events and messages, never stored; the
  card's own `log` is the primary story.
- Messages groups the one event log client-side (a DM thread per session pair, a broadcast
  thread per project); `hub:*` traffic belongs to the Overseer view. Any surface that renders a
  log rolls up repeats (`shared/rollup.ts`); one implementation, so Overseer and Home cannot
  drift.
- Proposals render from one module everywhere a decision could go unnoticed; an empty queue
  renders nothing. A denial requires a note, stored as the hub's denial memory.
- Notifications fire only for a direct message to this operator, a verify gate opening, or a
  crew seat failing. Duty-dark notifies on the healthy-to-dark edge once per episode, never on a
  first read that is already dark. The `/health` duty shape is
  `{ configured, online, lastSeenMs, darkSinceMs, queuedEscalations }`, shared with the doctor.
- Inbox staleness derives only from work state (referenced cards closed, or superseded by a
  newer message from the same sender), never from age or sender presence.

## Editor, files and git (`features/code/*`)

- Editor invariants (#5809): files are always editable, the seat-working guard is asked through
  Rust; the Changes view renders the same draft as a HEAD-vs-live diff, so dirty tracking, save
  and the conflict bar are one truth; there is no separate read-only diff tab.
- The document store lives at module scope keyed by project (the Code surface unmounts on every
  lens switch). Tab mutation is pure in `codeTabs.ts`; disk-conflict decisions live in
  `tabGuard.ts`; the disk-moved flag lives on the tab so it survives switches. Tab identity is
  scope + path; a plain open replaces the preview tab, only a pin makes it permanent.
- A draft is stashed only when its document finished loading AND the view hydrated its local
  draft from that document; otherwise a stash overwrites real work with the initial empty
  string. `decideReload`: no baseline sets one; unchanged does nothing; changed with unsaved
  content is a conflict that never clobbers the operator; changed with a clean editor reloads.
- `CodeView`: `path` is identity (a change forces a fresh instance); a new value for the same
  path is pushed via `pushEditOperations` to keep the undo stack, skipped while a tab is still
  resuming (#5857); the setup guard is cleared on every path change. Monaco stays local (vite
  `?worker`, never a CDN), TS semantic diagnostics muted, JSX Preserve, one theme
  (`trantor-calm`) from `src/styles.css`.
- Bulk SCM actions send one batched git call (E2BIG, RESEARCH-orca-files §3). GitPanel has no
  discard action by design; a refused mutation's text surfaces verbatim. File tree
  create/rename/delete are path-guarded to the project root.
- Ghost text: every scheduled request settles (a superseded one resolves null); the 2s ceiling
  in `ghostGate.ts` is time-to-first-line; superseded requests cancel on the Rust side too.
- Tab strip truncation (#6036): width is measured from twin buttons that are direct children of
  the real strip (so `.tr-seg > button` applies), plus computed gap and padding; hysteresis
  prevents flicker; an unmeasured strip defaults to labels.
- Persisted UI state: per-project state (right panel tab and dock, #6499) goes to
  `~/.agent-bus/config.json` like dismissals and onboarding; per-mode or global state
  (pane width, chat prefs) uses localStorage through an injected store, decoded defensively.
  Mode widths (300 Files/Git/Sessions, 440 Chat) come from the design artboards.

## Workspace and herdr (`features/workspace/*`)

- herdr command shapes are a frozen contract with codex (#5366/#5399); a change goes through
  the architect. `herdr_seats()` parses `~/.agent-bus/herdr-windows.txt`
  (PROJECT\tKIND\tAGENT\tHANDLE), keeps `KIND == "herdr"` rows, last row per (project, agent).
  Terminal functions attach a client pty and stream raw bytes; there is no pane-read polling.
- `PaneTarget` carries two identities never conflated: `agent` (the herdr pane name, the
  orchestrator row's is always "orchestrator") and `brand` (what the tab's mark shows, via
  `brandFor`'s host-name rule, #5890).
- Seat activity precedence (#5965): trust herdr's `agent_status` only when detection actually
  ran; runner-driven seats (kimi, glm) fall back to the hub peer status the runner writes at
  every turn boundary (`working · <trigger>`, `idle`, `down:`, `errored:`). Pure and unit-tested.
- FOCUS (one seat, full size) is the default; GRID is opt-in. Workspace renders only real hub
  data; a missing source is an explicit placeholder. A Terminal-hosted orchestrator cannot be
  mirrored (macOS pty), and the empty state says so and points to Chat (#5479). When the seat
  has no herdr surface, TerminalPane renders nothing and the placeholder ghost shows.
- TerminalPane: a WebglAddon that never activated must not be disposed (the throw lands in an
  effect cleanup and unmounts the tree); a lost context's addon must be disposed. Multi-char
  `onData` fragments buffer briefly and flush as one bracketed paste; single keystrokes pass
  through at once. Drop hit-testing uses the topmost element, not a rectangle, and every drop
  write is traced (#5921). `PaneBoundary` contains a pane crash to that pane.
- Handoff progress: Rust marks the project for the whole chain (write, idle gate, kill, reopen,
  kickoff) through one invoke and one event owned by `handoff_now`. Session dismissals are
  keyed on (project, sessionId) and persisted in config.json (#6476).

## Fleet balances (`features/fleet/*`)

- Chip semantics mirror `lib/balances.mjs` exactly so the header and the CLI agree. Data comes
  from the machine-local hub. Never poll provider usage per minute (the Claude OAuth endpoint
  429s); `REFETCH_AFTER_MS` bounds staleness to about 10 minutes. A failed fetch dims stale
  values, never an error banner; an unreachable provider reads "unreachable", never "sign in",
  because this data plane has no credential visibility. `UsagePopover` and `usageRoster.ts`
  reuse the strip's report and never fetch. Gemini rows are hidden unconditionally (CLI retired).
  `chipFrom` never throws on a nameless row (#6391). Brand marks are vendored from
  `@lobehub/icons-static-svg` (MIT), single-path, `currentColor`.

## Drills, genesis and test seams

- Drill Mode runs only against a disposable `drill-*` project; card moves go to the trantor hub.
  Auto-checks may pre-fill a verdict but never move a card; only the operator's press does.
  The seat writes a drill script; only the orchestrator launches it. `TRANTOR_KEY_DRILL_PROJECT`
  opens that project's Workspace so a terminal pane exists for pass 2.
- `genesisFlow.ts` is a pure transition table (no React, no invoke). The sheet closes when
  `trantor new` succeeds; the wake runs detached and reports by toast. `wake_in_progress` on the
  chain is the mount-time truth; an "ended" event clears only a row still in flight.
- Tests inject dependencies through the component's own seam (`TerminalDeps`, `ChatDeps`, the
  prefs store, the sheet's deps, #6253) with a faithful in-memory implementation, never a module
  mock. `terminalDouble.ts` fakes only pty bytes and keystrokes.
- Autonomy settings are read and written only through the CLI (it enforces the dial dependency
  rules). Settings stays read-only for hub pins and identity (`trantor hub set`, enrolment).
- `MarkdownText` renders every token as a React element; a reply can never inject HTML. Icons
  are bundled locally (CSP); avatar shape is a type signal (circles agents/humans, rounded
  squares projects); `monogramFor` returns exactly two characters.

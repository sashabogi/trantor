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

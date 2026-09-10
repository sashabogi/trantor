# Contract: the desktop shell (`desktop/src-tauri/src`)

The seams the Rust side holds. `docs/SYSTEM-CONTRACT.md` §4 is the ownership table; this sheet is
what the module comments used to restate. Incident stories are on the cards named here.

## Identity and transport (`identity.rs`)

- Signing happens in Rust so the private key never reaches the webview. The canonical string is
  byte-identical to `lib/identity.mjs`: `trantor-v1`, METHOD, PATH+QUERY, sha256(body) hex or
  `""`, unix ms, 16 random bytes hex, newline-joined. Keys are read from
  `~/.agent-bus/keys/<safe-name>.json` and never written.
- Requests and the SSE stream run in Rust because macOS App Transport Security blocks cleartext
  HTTP from WKWebView. Reconnect backoff is capped and `since` resumes from the last id.
- One SSE stream per hub, fanned out over Tauri's event bus; a second subscriber never opens a
  second connection.
- A known project is a hub pin or a checkout on this machine, never "any name the bus mentioned".

## herdr (`herdr.rs`, SYSTEM-CONTRACT §4 "prompt delivery", "agent lifecycle")

- The one place the app speaks to herdr's agent surface, over the local socket (newline-delimited
  JSON, protocol 20), one request per connection. Never the CLI: composer text is arbitrary and a
  leading `-` breaks argv.
- Prompts ride `agent.prompt` (herdr owns paste mode, Enter encoding, and refuses a blocked agent
  before any bytes land). Hot-path queries use a short read budget: a load-slowed server once held
  one query for the full default and stalled the transcript tail.
- Picker answers (#6094) ride `pane.send_text`, the pane-level primitive with no agent-lifecycle
  gating, because the picker IS the blocked state. Never `herdr agent attach`: a watch client is
  read-only by design and writing into it returns EIO.
- The runtime identity authority is the pane's own report (`agent_session`, source
  `herdr:claude`), correct the moment a successor boots; `orch-sessions.txt` is the durable
  fallback. A report wins only when its transcript exists on disk (an ephemeral `claude plugin
  update` run can poison it). Never "the newest transcript": that guess belongs to the adopt
  picker, in front of the operator.
- Per-pane `pane.agent_status_changed` subscriptions are live-only; the global `pane.*` types
  replay history, which is why status is subscribed per pane and re-seeded via `agent_status()`.
- Test fixtures in `herdr.rs` are captured from real socket replies, not invented.

## Chat reader (`lib.rs`)

- The chat is the orchestrator's JSONL transcript, addressable because `trantor open` chooses the
  session id. `after` is a line offset (append-only, survives a restart).
- Turn parts are decoded from what a transcript actually contains: assistant text, thinking,
  tool_use; user text, tool_result, image. A raw TUI y/n prompt never reaches the transcript;
  AskUserQuestion is an ordinary tool_use and is kept (#6094). The CLI writes one row per content
  block, so an in-progress turn is several rows with no `user` row yet.
- Harness injections (hook output, notices, reminders) arrive as user turns and are filtered by a
  closed prefix list, never by length. A slash command is one bare first token; a path is not.
- Queue operations are the operator speaking mid-turn: `enqueue` renders as a queued (sent, not
  yet seen) message, `remove` is bookkeeping. Harness notices ride the queue too and get the same
  filter. A turn's end is a `system` row (`turn_duration`, `stop_hook_summary`) and re-seeds the
  status once per turn end (#5993).
- Tool results are returned separately from turns and paired on the front end.
- Everything the agent IS is `reported` by the transcript; an empty field renders as absent.
- The context gauge's poison guard (#5572) is the same rule, from the same fixture manifest, as
  `hooks/lib/handoff.mjs`: report the last row unless it falls below 40% of the running max, then
  the recent max, unless five consecutive rows sit low.
- Chat and status watchers share a stop flag keyed by `project:session` and carry a generation;
  a stale unwatch never kills a fresh watcher (#6113). Status is pushed by a per-pane subscription,
  not polled; the quiet-tick doubles as the health loop. `window.emit()` must run from a
  `tauri::async_runtime` task, never a raw OS thread, or the frontend never hears it (#5993).

## Handoff chain and kickoff (`lib.rs`, `terminal.rs`, `genesis.rs`)

- Entry guard (#6668): the orch pane must exist and hold a live agent, or `handoff_now` refuses
  before writing anything. The graceful-end target is the foreground pid from `pane process-info`,
  never the pane's shell.
- The chain waits (bounded) for the CLI's own boundary gate to write the record when the baton was
  only armed (#6528), then holds the pre-kill idle gate (#6081): only `working`/`busy` holds it;
  `HANDOFF_IDLE_DEADLINE` (120s) is the gate for a session parked in `relay_wait`, and the label
  says which side of the gate the kill happened on. The pane is marked from first step to last so
  nobody types into a doomed session.
- Kickoff after reopen (#5649, #6184, #6139): one boot prompt over the socket, sent only once the
  agent reads idle, retried on the kickoff cadence for transient outcomes (NotReady, NoAgent, Err;
  Stalled exactly once), never past Blocked. Before any retry the pane is asked; an agent now
  working or blocked is mid-turn on our prompt (#6201). The Wake button rides the same ladder.
  Every herdr call sits on `spawn_blocking`.
- `trantor open` resolves the project directory before running the CLI (the app's cwd is nowhere
  near the checkout). A reattach ("already hosted: reattached") is never typed into.
- The woken session's boot prompt never asserts a handoff exists.

## Local session truth (`lib.rs`)

- ACTIVE means "a terminal window open and registered" (operator ruling). Heartbeats only prove
  mid-turn. OPEN is process truth (interactive `claude` windows, crew-runner seats) plus every
  project whose orch pane herdr can still name an agent for, wherever that pane runs (#6163).
- Interrupted sessions (#5401): a tracked orch row whose pane has no agent, queried at launch only
  (a deliberate `/exit` also leaves one). A dismissal (#6476) is persisted in config.json and keyed
  on (project, session handle) so a new dead session for the same project still shows.
- Onboarding and right-panel state live in config.json too; an install with a hub pin from before
  onboarding existed is migrated past the wizard on first read. Tests that repoint `AGENT_BUS_DIR`
  hold `BUS_DIR_TEST_LOCK` for their entire body and restore the prior value.

## Code lens, git, files (`lib.rs`)

- A save is a file write and nothing else (#5809, Orca's anatomy); staging and commit are
  explicit. A file a seat is writing (herdr says working) refuses a human write: one owner for
  that answer.
- Git panel (#5775): one read snapshot and three mutations against the seat's worktree; porcelain
  is parsed in `-z` form, a rename's origin path is consumed, no entry is guessed. No-upstream is
  an explicit state. `+N/-N` comes from one `git diff --numstat HEAD` per request; untracked and
  binary map to nothing (#5811).
- Every git/fs handler passes `resolve_within`: canonicalize, then require a descendant of the
  canonical root; a symlink cannot lie past it.
- `terminal_path()` asks the login shell for PATH first: a Finder-launched app inherits a bare one.
- Project icons come from the repo on this machine, with monorepo subroots checked; none is the
  normal answer. Attachment chips read size and an inline thumbnail off disk; a pasted image is
  written under `~/.agent-bus/attachments/` and attached like a drop.
- Autonomy dials are read and written through the CLI; the validation lives once, in
  `lib/autonomy.mjs`. Balances are re-queried through their owner, never by the app itself.
- Self-update mirrors `bin/app.mjs` release discovery in-process, since a Finder-launched app has
  no CLI on PATH.

## Ghost text (`ghost.rs`, #5897, #6160)

- One direct OpenAI-compatible call from the app process; config from `~/.agent-bus/.env` at
  runtime (qwen preferred, deepseek fallback); max_tokens 32, stop at the first blank line, 2s
  budget. Streaming measures time-to-first-line and aborts the rest. The stream prompt puts stable
  bytes first so the provider's prefix cache hits. Everything that shapes the request is a pure,
  unit-tested function; the latency probes are `--ignored` because they spend the key.

## Crash boundary and drills (`lib.rs`, `key_drill.rs`, `handoff_drill.rs`, `drill_mode.rs`)

- A panic on the main thread inside AppKit's `sendEvent` cannot unwind (#5917, #6317). The panic
  hook writes message, thread, location and backtrace to app-panics.log before the abort; the
  vendored tao catches Objective-C exceptions at the `extern "C"` boundary and reports them; every
  Tauri command runs under catch_unwind (tauri 2.11.5 has none of its own).
- Drills are inert unless their env var is set: `TRANTOR_PANIC_DRILL`, `TRANTOR_KEY_DRILL`
  (`post`/`throw`, plus `TRANTOR_KEY_DRILL_PROJECT`), `TRANTOR_HANDOFF_DRILL`, `TRANTOR_ASK_DRILL`
  (plus `TRANTOR_ASK_DRILL_WRITE_TARGET`, never the real orchestrator). Exit 0 on pass, 3
  otherwise. The seat writes a drill; the orchestrator stages and runs it. Drill Mode (#6800)
  captures evidence with `screencapture` under `<bus dir>/drills/`, label sanitized.

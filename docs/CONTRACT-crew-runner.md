# Contract: the crew runner (`bin/crew-runner.mjs`)

The runner keeps a seat alive without spending tokens: it long-polls the bus over plain HTTP,
and when a message addressed to the seat arrives it resumes the CLI session with that message as
the prompt. The model works and ends its turn; the runner owns waiting, delivery, failure
reporting and the time box. This file holds the seams those comments used to narrate; the
incident stories are on the cards named here.

## Delivery (the runner owns it, not the hub)

- The hub hands a message out exactly once: the poll cursor advances on read and nothing re-fires.
  So a wake message is not consumed until a turn exits 0. The pending queue lives on disk
  (`~/.agent-bus/pending-<agent>-<project>.json`), survives a restart, retries on its own backoff
  (30s rising to 15 minutes; `TRANTOR_RETRY_MS` shortens the ladder for drills), and every report
  says how many are outstanding.
- Shedding writes the queue back to disk immediately: `trantor duty status` reads the file, so
  memory and disk must never disagree (#7131).
- Hub-generated staleness alerts expire (`TRANTOR_HUB_ALERT_TTL_MS`, default 30 minutes) because
  they describe a two-minute condition; a message from a peer is never dropped for being old.
- Wake policy: a direct message carrying no card and no instruction (an ack, an FYI, a queue note)
  batches into the next turn instead of buying one. Typed alerts and overseer file-conflict /
  linked-activity warnings still wake (#5760); the hourly same-project-sessions FYI batches.
- Cross-project fence (#6228): a wake from a sender whose home project is not this seat's, and not
  `trantor policy link`ed, is dropped with one report back to the sender. The hub's own agents
  (`hub:duty` and friends) are exempt; they speak for this hub's projects (#6301).
- Whoever sent the message that woke the seat is told directly what became of it. Direct messages
  wake; broadcasts do not.
- The announce on boot is signed by the runner as this seat, never by the CLI: opencode seats
  sharing one MCP daemon once announced under each other's identity.
- One session per card (#6134): a wake whose card differs from the last one starts a fresh CLI
  session and tells the seat so. The card is bound by shape, not by the first `#NNNN` in the text
  (#7061), or a wake that opens with a merged card binds the turn to it.

## Turn execution

- Every seat spawns detached, in its own process group, with stdin at `/dev/null`: a background
  group that reads the terminal takes SIGTTIN and stops forever.
- `pipefail` is mandatory: the sid-capture `| tee` otherwise makes a failed turn exit 0.
- `ERRF` is the total output capture, stdout and stderr both (#5481). Redaction rides in the
  pipeline: `lib/redact.mjs` echoes stdin to the live window and appends only redacted bytes to
  `ERRF` (#5869). The tee topology is load-bearing; the sid path folds stdout in via
  `/dev/stderr` and the `--tee2` hop.
- Before classifying a live turn the runner waits (bounded) for the scrubber's drain marker:
  macOS bash 3.2 `wait` does not wait for process substitutions, so an auth line can still be in
  the pipe when `spawnSync` returns. A cut turn skips the wait, because the sweep killed the
  scrubber.
- Env precedence: files are prepended, so the one prepended last runs first and the one that runs
  last wins. `~/.agent-bus/.env` (the crew layer) is iterated first so it wins over the agent's own
  fallback; `test-crew-env.mjs` runs the real shell to prove it.
- The opencode family never resumes blind (#6154): `run -c` continues the globally last session on
  the machine, any project's. Every spawn pins `--dir` to the seat worktree and a resume pins `-s`
  to the newest session for that directory in opencode's own sqlite DB. A missed lookup starts a
  fresh session, never a foreign one.
- Every fetch carries a hard deadline (the poll's own wait window plus slack): a long-poll whose
  socket dies silently otherwise hangs forever and the seat reads as parked.
- herdr drops a pane's agent registration when the process inside exits, and a seat's CLI exits
  every turn, so the runner re-reports the agent at every turn boundary (pane id first, then flags).
- Activity truth (#5965): the runner reports `working · <trigger>` at turn start and `idle` on a
  clean landing, one bounded HTTP call per transition. herdr cannot see a runner-driven CLI mid-turn.
- Every prompt section is capped and the whole payload has one hard total cap (#5683,
  `bin/crew-payload.mjs`); below the caps the composition is byte-identical to plain concatenation.
- A runner-managed seat never hands itself a baton: `TRANTOR_NO_HANDOFF_SPAWN` and
  `TRANTOR_NO_BATON_SPAWN` are set, because the runner is the seat's lifecycle manager and an
  interactive handoff spawn leaks a session into a window nobody asked for.
- `TRANTOR_SEAT=<project>` badges the seat's env; `crew.mjs up` refuses to bring up a different
  project's crew from a shell carrying it (#6228). A bare `RELAY_PROJECT` override keeps working.

## The time box and the watchdog (#6134, #5684, #6206)

- `TRANTOR_TURN_MAX_MS` (default 20 minutes) ends the turn from inside bash: at the deadline the
  shell walks its own descendants with `pgrep -P` and kills bottom-up. Killing the group from node
  misses grandchildren that `setsid` moved to another group, and by then survivors are reparented
  to init. A marker file (`turncut-<agent>-<project>`) is how node learns the turn was cut rather
  than that the CLI died.
- A cut prose turn gets exactly one follow-up in the same session ("commit what is done, move the
  card, report in one line"). A state step gets none: the follow-up prompt is not a TurnResult
  prompt, and the driver recovers a cut step from git (TDD §4.4); the step is recorded `cut: true`.
- The watchdog is a detached process armed by a stamp file. A turn past the window with no
  activity on transcript, worktree or stderr earns one direct stall report to the foreman, never a
  kill. Stdout silence alone is never a stall. The floor is 10 minutes and is never derived from
  the time box (`TRANTOR_TURN_WATCHDOG_MS` exists for drills). Every exit path kills the watchdog,
  and its stamp carries the runner instance id so an orphan never speaks for a later runner.

## Classification and parking

- A zero exit is not proof the turn ran (#5405): opencode prints its auth error and exits 0. The
  rules live in `lib/classify-failure.mjs` (#5868) and judge only the CLI's own output, echo
  stripped; a long output is a real answer and a warning inside it does not fail the turn.
  Telemetry keeps the real exit; call sites branch on the effective one.
- Exit 0 with an empty `ERRF` is the null-completion trap (#5481), because every real CLI prints
  something on success. On a state step the answer is the envelope and an empty `ERRF` is the
  normal healthy shape (#6969).
- A dead seat is not retried (#6134): a spent plan or a rejected key parks the seat, keeps the
  queue, stops the ladder, tells the room once with the reset time when the CLI printed one, and
  rings the operator out of band (`notifyOperator`, silenced by `TRANTOR_NO_DESKTOP_NOTIFY=1`).
  The alarm for "the bus is stuck" cannot itself be a bus message.
- Two consecutive exit-1 turns on one contract park the seat (#6289): the first failure retries,
  the second parks with a reason (`time-box` when the chain died to cuts, `api-error` otherwise).
- `RUNNER_PARK_MAX_MS` is set only by `trantor duty up`, which runs under a launchd keepalive: past
  the ceiling the seat exits and the supervisor restarts it clean. Unsupervised seats stay parked.
- Failure state is announced on change, not on every retry (the monitoring doctrine).
- The pulse (`RUNNER_PULSE_MS`) re-runs an orchestrator seat's mission note on a cadence; an empty
  mission means stand by.

## Trantor State, Phase 2a (TDD §4.1, §4.6, §7.3)

- Off by default; off means the transcript path runs byte-identical, which
  `test/state/test-runner-state.mjs` asserts against the spawn strings.
- Reachable only when `TRANTOR_STATE_ASSEMBLE=1`, the seat is `claude`, and the installed CLI
  carries `--json-schema` (probed, never assumed). The boot line says "armed", not "on": the
  kickoff runs before any message exists and cannot be a state step (#7060).
- A state step is a fresh `claude -p` carrying the assembled prefix; there is no `-c`.
- `stateSkip` is the one place a turn decides whether it is a state step, and it speaks on change,
  not on repetition (#7060, #7118).
- The runner is transport only: it hands `lib/state/driver.mjs` a way to run the CLI and a way to
  act on the returned action, and returns an exit code so the delivery ladder is untouched.

# Contract: the crew runner (`bin/crew-runner.mjs`)

The runner keeps a seat alive between turns: it long-polls the bus over plain HTTP, and when a
message addressed to the seat arrives it runs the seat's CLI with that message as the prompt. The
CLI ends its turn; the runner owns everything around it. Card #6450 moved these contracts here
from comments; the incidents behind them live on the cards linked below.

## Delivery: the runner owns it, not the hub

- The hub hands a message out exactly once and its cursor advances on read. A wake message is
  therefore held in a runner-side queue (`~/.agent-bus/pending-<agent>-<project>.json`) and is
  consumed only when a turn exits 0. The queue survives a runner restart.
- Redelivery backs off from 30 seconds to a 15-minute ceiling. `TRANTOR_RETRY_MS` (comma-separated
  milliseconds) shortens the ladder for drills.
- Two failure reasons park the seat instead of retrying: a spent plan and a rejected key (#6134).
  Parking keeps the queue, stops the ladder, tells the room once (with the reset time when the CLI
  printed one), and rings an out-of-band operator notification because the alarm for a stuck bus
  cannot itself be a bus message. `trantor up` resumes a parked seat.
- Two consecutive exit-1 turns on one contract park the seat with reason `time-box` when the chain
  died to box cuts and `api-error` otherwise (#6289). The first failure retries; the second parks.
- `RUNNER_PARK_MAX_MS` is set only by `trantor duty up`, which runs under a launchd keepalive: past
  that ceiling a parked seat exits so the supervisor restarts it clean. Unsupervised seats never
  exit on park.
- A hub-generated staleness alert expires after `TRANTOR_HUB_ALERT_TTL_MS` (default 30 minutes).
  A peer's message never expires.
- After shedding expired alerts the queue file is rewritten immediately, because `trantor duty
  status` reads the file and must agree with memory.
- A wake that names another project's home, unlinked by `trantor policy link`, is dropped with one
  report back to the sender (#6228). The hub's own agents (`hub:duty` and peers) are exempt (#6301).
- A direct message carrying no card and no instruction is context, batched into the next turn
  instead of waking one. Typed alerts and overseer file-conflict and linked-activity warnings still
  wake; the hourly same-project-sessions FYI is batched (#5760).
- The failure state is announced once per change, never per retry (monitoring doctrine).

## Sessions

- One CLI session per card (#6134): a wake bound to a different card starts a fresh session, and
  the seat is told so. The binding card is read by shape, not by position in the text (#7061).
- The opencode family (deepseek, glm, kimi) never resumes blind (#6154): every spawn pins `--dir`
  to the seat worktree, and a resume pins `-s` to the session id looked up in opencode's own
  database by directory. A missed lookup starts fresh, never a foreign session.
- DeepSeek Harness runs every turn as a fresh session; `trantor connect` builds the
  `~/.dsh/profiles/trantor` composition and no model flag is passed.
- The seat env carries `TRANTOR_SEAT=<project>` (#6228), which `bin/crew.mjs`'s `up` guard reads to
  refuse bringing up another project's crew from that shell, and `TRANTOR_NO_HANDOFF_SPAWN=1`
  plus `TRANTOR_NO_BATON_SPAWN=1`, because a runner-managed seat never hands itself a baton.
- Env-file precedence: files are prepended, so the list is iterated highest priority first and the
  crew layer `~/.agent-bus/.env` wins over the agent's own fallback. `test-crew-env.mjs` runs the
  real shell to prove it.
- Every HTTP call to the hub carries a deadline of the poll's own wait window plus slack; a
  silently dead socket surfaces as a retryable error instead of a hung poll.
- The runner announces the seat itself, signed as the seat, because the runner process is per-seat
  by construction and its signature cannot be borrowed.
- The boot telemetry line records the hub URL the runner bound to.

## A turn

- The turn runs under `bash -o pipefail` in a detached process group with stdin on `/dev/null`.
- ERRF is the total output capture: stdout and stderr both land in it through `lib/redact.mjs`
  (#5869), which echoes verbatim to the window and appends only redacted bytes. The tee topology is
  load-bearing (#5481): an empty ERRF on exit 0 is the null-completion trap and fails the turn,
  judged on echo-stripped text (#5868). On a state step ERRF holds only stderr, so silence there is
  the normal shape (#6969).
- A zero exit is not proof the turn ran (#5405): an auth failure in the CLI's own output fails the
  turn when that output is short enough to be just the error (#5868). Telemetry keeps the real exit.
- Before classifying a live turn the runner waits, bounded, for the scrubber's DRAINF marker, since
  bash 3.2's `wait` does not wait for process substitutions. A cut turn is never drained.
- Time box (#6134): `TRANTOR_TURN_MAX_MS` (default 20 minutes) fires from inside the shell, which
  walks its own descendants with `pgrep -P` and kills them bottom-up, then writes the CUTF marker.
  Exactly one follow-up turn runs in the same session to land the work. A state step gets no
  follow-up (TDD §4.4) and is recorded with `cut: true`.
- Watchdog (#5684, #6206): a detached watchdog armed by a stamp file sends one stall report to the
  foreman when the transcript, worktree and stderr are all quiet for `TRANTOR_TURN_WATCHDOG_MS`
  (floor 10 minutes, never derived from the time box). It never kills. Every runner exit kills its
  watchdog, and the stamp carries the runner instance id so an orphan never speaks for a later
  runner.
- Prompt composition (#5683): every section is capped by `bin/crew-payload.mjs` and the whole
  payload has one hard total cap; below the caps the composition is byte-identical to the plain
  concatenation.
- Turn boundaries are reported to the hub (#5965): `working · <trigger>` at start, `idle` on a
  clean landing, bounded to 5 seconds, one call per transition. herdr's pane registration is
  re-reported at every boundary because a seat's CLI exits each turn.
- The sender of the wake is told directly what became of it; direct messages wake, broadcasts do
  not.
- `RUNNER_PULSE_MS` re-runs an orchestrator seat's mission note on a cadence; an empty mission
  means stand by.

## Trantor State (Phase 2a)

- The flagged path is reachable only when `TRANTOR_STATE_ASSEMBLE=1`, the seat is `claude`
  (TDD §7.3) and the installed CLI carries `--json-schema` (§6). Off means the transcript path is
  byte-identical; `test/state/test-runner-state.mjs` pins the command strings.
- The boot line says "armed", which is a claim about configuration, not the prompt (#7060). A turn
  is assembled only when a wake assigns it a card; the kickoff and every pulse run the transcript
  path, and a skip is spoken on change, not on repetition.
- A state step is a fresh `claude -p` carrying the assembled prefix, with no `-c`, held to the
  TurnResult grammar by `--json-schema`. `lib/state/driver.mjs` holds the §4.1 order; the runner is
  transport and side effects.

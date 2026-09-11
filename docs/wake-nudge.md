# Mechanical local wake (#7429)

`node bin/wake-nudge.mjs up --hub <url>` installs the macOS launchd job
`com.trantor.wake-nudge`. It uses the existing `claude:trantor-duty` signing
identity, RunAtLoad, KeepAlive, and a 30-second crash throttle, like `bin/duty.mjs`.
`down` unloads and removes the job; `status` prints launchd state. `run` runs in
the foreground and `once` performs one pass. Logs go to
`~/.agent-bus/wake-nudge.log`; `AGENT_BUS_DIR` overrides that directory.

The daemon reads `/events?type=message&by=hub%3Aduty&limit=2000`; it does not consume
duty's inbox or change its delivery cursor. It ignores alerts older than 24 hours
and messages already delivered according to `/peer`. The default hub is
`config.hubs.trantor`, then `config.url`; `--hub` overrides both.

A recipient must match this machine's bus host identity. Herdr's current Claude
session report takes precedence over the project's `orch-sessions.txt` map.
The process table must identify exactly one Claude pid for that session; the pane's
foreground process list supplies the fallback for sessions without a resume flag.
Busy panes, ambiguous matches, other hosts, absent sockets and absent tokens fall
through to duty. Only read operations are used against herdr.

The socket is `/tmp/cc-socks/<pid>.sock`. macOS `ps eww` often exposes only Claude's
initial environment, before it exports its messaging token. The daemon also checks
that Claude process's descendants, excluding nested Claude sessions, for an inherited
`CLAUDE_CODE_MESSAGING_TOKEN` paired with that exact `CLAUDE_CODE_MESSAGING_SOCKET`.
Tokens stay in memory and are never included in logs or command arguments.

Socket delivery sends two NDJSON lines: an auth frame, then a user frame addressed
to the resolved Claude session ID. Its content is wrapped in
`<cross-session-message from="trantor:wake">` and names only unread message IDs and
the bus tools to use. Sender-controlled message bodies never enter the nudge.
No terminal input is used.

The shared `lib/duty-nudges.mjs` claim lock coordinates with the duty runner.
A nudge is recorded in `duty-nudged.json` only when that session's inbox-poll stamp
advances after the post, within 10 seconds. A socket write alone is insufficient:
held/refused messages or failed auth do not prove a wake. Unverified claims are
released for duty triage, and the daemon attempts each ID at most once per process
lifetime. Recorded successes remain deduplicated across daemon restarts.
The poll stamp proves inbox polling, not that the recipient replied. A concurrent
natural poll can also advance it; busy herdr panes are excluded to reduce that race.

The latency path is the hub's default **2-minute UNDELIVERED threshold**, followed
by the daemon's **2-second polling interval**, socket post, and the recipient's
next inbox hook. The duty model's 2–15-minute turn cadence is outside this path.
The hub timer cadence and the recipient's inference/tool latency still apply.

Run the focused checks with:

```sh
WAKE_NUDGE_LIVE=1 node --test test/crew/test-wake-nudge.mjs
node bin/slop-gate.mjs
```

The live drill launches a dedicated `claude -p` with streaming stdin, an isolated
HTTP hub on an ephemeral port, a minimal inbox MCP server, and the real PostToolUse
inbox hook. It first proves that polling has stopped, then publishes an UNDELIVERED
alert and asserts that the poll stamp advances within 15 seconds. A second session
in hold mode must leave the stamp and nudge ledger unchanged. Only those drill
processes are stopped. Artifacts and the result JSON are under `.agent-bus-out/`;
the drill does not install a production daemon. The live drill uses existing Claude
authentication (the OAuth env token or the macOS Claude Code keychain entry).

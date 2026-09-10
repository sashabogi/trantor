# Contract: the shared library (`lib/`)

The seams `lib/` holds, one section per module family. Trantor State (`lib/state/`) has its own
sheet in `docs/CONTRACT-state.md`; the platform TDD (`docs/TDD-trantor-platform.md`) is the source
for identity and the store. Incident stories are on the cards named here.

## Identity, signing, enrollment (`identity.mjs`, `signed-fetch.mjs`, `enroll.mjs`, TDD §7)

- An identity is an Ed25519 keypair; the label is cosmetic. Every primitive sits behind
  `identity.mjs` so a second scheme could be added without touching a call site. No Nostr interop.
- Session-instance subkeys (`docs/INSTANCE-KEYS-CONTRACT.md`): the durable key endorses a per-instance
  key that signs traffic and dies with the session. The durable key keeps enrollment, grants and
  attribution.
- `sfetch` is the one signing drop-in for fetch. Fail-open is a contract: no identity or an
  unreadable key means the request goes unsigned and the hub decides under `RELAY_AUTH`.
- A crew seat enrols itself at startup with a single-use, project-scoped invite minted by the
  operator's owner key (legitimate because a crew only runs on the operator's machine); the seat
  never holds owner rights.

## Project identity and hub routing (`project.mjs`, `splitbrain.mjs`, `seats.mjs`)

- One repo = one lane: the project name is the git repo root basename; `RELAY_PROJECT` always
  wins. A linked worktree resolves to its MAIN repo's name via git-common-dir (seat worktrees
  live under `~/.agent-bus/worktrees/<project>/<agent>`).
- A project lives on exactly one hub (TDD §12.1): `RELAY_URL`, then `config.hubs[project]`
  (the only deliberate routing), then the legacy global `url`, then the local default.
  `resolveHubInfo` reports the provenance (`env`/`pin`/`global`/`default`) so callers can warn:
  the silent fallback to an unread hub is the most expensive failure this system has.
- `busDir()` honours both `AGENT_BUS_DIR` and `RELAY_DATA_DIR`; a reader that honours neither
  mutates the operator's real state during a drill.
- The orchestrator-session map (`orch-sessions.txt`, one TAB row per project) is shared by
  `trantor open`, `trantor adopt` and the handoff hooks so the thread survives a handoff.
  `orchWriterSid` decides by evidence: `TRANTOR_ORCH` matching the project, else the recorded
  thread's transcript freshly written.
- A non-seat (home, a folder holding two or more repos, the plugin cache) never registers;
  `nonSeatReason` names why. A plain non-git directory is still a seat.
- `hostId` is stable and persisted (`machine-id`): `RELAY_HOST_ID`, then the persisted id, then
  the macOS LocalHostName, then `hostname()` without its domain.
- `withEnvFiles`: files are prepended, so the one prepended last runs first and the one that runs
  last wins; callers pass highest priority first. `test-crew-env.mjs` proves it in a real shell.
- Split-brain detection is a cross-check: probe every known hub for who is live and compare with
  the pins. An unsigned read of an enforce hub answers 401 with valid JSON; `probeHub` reports a
  reason, never a confident empty roster, and `analyze` carries unreadable hubs as `blind`.
- Declared seats: a seat exists because it was declared and is live because a real agent process
  stands in its directory (`ps` + `lsof` cwd), never because the hub's presence list says so.

## Redaction and scrubbing (`redact.mjs`, `scrub.mjs`)

- `redact.mjs` (#5869) scrubs key shapes to `<redacted:NAME>` before bytes land at rest: `sk-`
  prefixes, `AIza`, `xai-`, `ghp_`, `<VAR>_KEY=` / `<VAR>_TOKEN=` with a 32+ char value, and
  `Authorization: Bearer`. Rules anchor on a prefix or position, never on "looks long"; ordinary
  lines are byte-identical; the function is idempotent. As the runner's tee replacement
  (`--tee` / `--tee2`) the redacted append is line-buffered, and every byte lands exactly once.
- `scrub.mjs` protects the append-only event log. A 64-hex string is flagged as a private key only
  with an intent word (`priv`, `secret`, `seed`) within the preceding 40 chars, because pubkeys and
  sha256 body hashes have the same shape and are legitimate protocol traffic.

## Store contract (`store-contract.mjs`, `store-pg.mjs`)

- The event log is the table; board state is a projection of it. Every field in `STORE_API`
  round-trips through Postgres, including the kv keys that used to live only in memory
  (`verifyGates`, `balances`, `handoffLog`, `aliases`, `phaseMeta`, `focus`, `proposals`,
  `contractReap`). A denied proposal is a memory; a restart that forgets denials re-opens every
  door the operator closed.
- Invariants carried forward from 0.17.54:
  1. Card events keep the legacy flat shape and legacy type names (`created`/`moved`/`updated`);
     every new event type is dotted. `/history` filters on that distinction.
  2. Message events carry `refs[]`, never `task_id`; `/card` counts card events only.
  3. Threads are derived, never stored.
  4. `delivered_up_to` is monotonic.
  5. Retention is time-based; deleting from `events` never deletes a projection row.
- Every writer NOTIFYs `trantor_changes` with `{"src":"<writer-id>"}` after a committed write; the
  hub reloads its projection on a foreign `src`. `saveDelta` touches only rows the hub has seen,
  inserts events with `ON CONFLICT DO NOTHING`, and emits the NOTIFY inside the transaction.
- `eventFromRow`: columns are the truth, payload spreads first. A payload `id` spread last once
  overwrote the row id and silently stalled the append-only log.

## Crew policy (`turn-policy.mjs`, `classify-failure.mjs`, `same-project.mjs`, `overseer.mjs`,
`duty-nudges.mjs`)

- Per-turn policy (#6134) lives here because the runner is a self-executing script. A wake binds
  to the card an assignment-shaped citation hands over (`ASSIGN_CARD_RE`, #7061): messages to this
  seat outrank mentions, the newest assignment wins, and only a batch with no assignment falls back
  to the newest message's first citation. `stateSkipReason` names the constraint that binds
  (#7060). `isLinkedProject` is the runner's half of the cross-project fence (#6228).
- Failure classification (#5868): prompt lines the CLI echoes back are replay, not speech
  (normalised, containment and 40-char-run matching, plus a verbatim check for short lines);
  exit-0 auth death fires only on a short error-only output and never when the turn shipped a
  commit; `exhausted` demands an explicit quota or rate-limit message.
- The same-project overseer warning is an episode (#5760): it fires once when the member set
  changes, keyed by a hash of the set, reports duration, and never counts the declared crew.
- Linked-project activity warns only on an EVENT: one file path claimed live from both sides, or
  one card held by live sessions from both sides (#7029). A declared link being live on both sides
  is the operator's own declaration and never a warning.
- Duty escalations are dropped when the recipient's `/peer` cursor (singular endpoint; `/peers`
  does not serialise `deliveredUpTo`) already covers the message. Unknown is never delivered.

## Autonomy (`autonomy.mjs`)

- Three dials, not one: `harness` (does the operator's claude ask), `acts` (what Trantor does on
  your behalf), and the crew agent's unattended autonomy, which lives on the hub as team state.
  The file is shared on disk because the app, `crew.mjs` and the runner all read it.
- `baton`: `ask` (default; the app's banner asks, the heartbeat neither arms nor fires) or `auto`.
  PreCompact stays the at-the-wall backstop in both modes (#5509 W2).
- Dependencies are enforced on read: push implies commit, deploy implies push, so a hand-edited
  file cannot smuggle a state the UI would refuse.

## Providers and balances (`providers.mjs`, `balances.mjs`, `provider-keys.mjs`)

- `providers.mjs` (#6390) is the one truth for "ready to seat": PATH detect, the CLI's own login
  command and credential artifact, and connected = a live usage call succeeded. The JSON row shape
  is frozen for the Accounts pane and wizard; every row carries a state and a non-empty reason.
  Probes are never duplicated: every live check is a `balances.mjs` adapter.
- Balances are queried only for providers in the operator's profile, never for every ambient key.
  Two kinds: prepaid (money remaining) and quota (percent remaining plus reset time). International
  endpoints for the Chinese providers. Every call is short-timeout and fail-soft.
- The hub runs under launchd with no keys, so env-having clients fetch and POST `/balances`.
- Claude: OAuth is primary (model-scoped windows); the statusline live cache answers when OAuth
  429s. Keychain lookup is attribute-only and skipped when a drill injects a home.
- Codex reads the ChatGPT backend's usage windows with the CLI's own token (#5570); only
  percentages leave the process, and an unreachable endpoint falls back to the subscription row.
- Qwen (#6131): the graded remaining percent is cookie-only, so the adapter reads the wall (a 429
  `insufficient_quota` from a zero-token `messages: []` probe) and says unknown otherwise.
- `provider-keys.mjs` sources keys exactly as the runner does: `~/.token-scrooge/.env`, then
  `~/.agent-bus/.env` (wins), on top of `process.env`.

## Integration and sub-agents (`integrate.mjs`, `subagent-manifest.mjs`, `subagent-scan.mjs`,
`seat-why.mjs`)

- The integration pass automates what the orchestrator did by hand: commit each seat's work as
  that seat, merge, check for collisions, prove, then push. Every stage can refuse and says why;
  a merge conflict is aborted and reported, never left half-done.
- The sub-agent manifest is a read-time projection of the transcripts on disk (meta.json, the
  parent's tool_result ids, each agent's jsonl, a disk reconcile), so a successor can tell what
  survived a killed build.
- `subagent-scan` recomputes notional cost only from transcripts still on disk, priced by the
  model each used, with implausible transcripts guarded out.
- `seat-why` reads local evidence in order: the err file, the runner telemetry, `crew-windows.txt`,
  live runners; returns `live | dead-quota | dead-auth | dead-crash | no-runner | no-pane`.

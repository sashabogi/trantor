# Contract: the shared client library (`lib/`)

Everything under `lib/` outside `lib/state/` (which has docs/CONTRACT-state.md). Card #6450 moved
these contracts here from comments; the incidents behind them live on the cards linked below.

## Identity and signing

- An identity is an Ed25519 keypair and the label is cosmetic (docs/TDD-trantor-platform.md §7).
  This closed the self-asserted `from` hole that once turned message delivery into remote code
  execution, and it lets two seats of one brand in one project be different peers. Every primitive
  is behind `lib/identity.mjs`, so a second scheme can be added without touching a call site; there
  is deliberately no Nostr interop.
- Session-instance subkeys (docs/INSTANCE-KEYS-CONTRACT.md): the durable key keeps enrollment,
  grants and attribution and endorses a per-instance key that signs traffic and dies with the
  session. This is the fix for the handoff-twin identity collision.
- `lib/signed-fetch.mjs` is the one call-site shape for every client. Fail-open is a contract: no
  identity, or an unreadable key file, sends the request UNSIGNED. Under `RELAY_AUTH=warn` the hub
  accepts and flags it; under enforce it answers 401, and the hub is the right place for that
  decision.
- Self-enrolment (`lib/enroll.mjs`, TDD §7.4): a seat created on demand is an unknown identity on an
  enforce hub and every call 401s silently. At startup the seat enrols with the operator's owner key,
  which mints a single-use, project-scoped invite the seat spends at once, so the seat never holds
  owner rights.

## Project identity and hub routing

- One repo = one lane, keyed by the git repo ROOT basename. A linked worktree resolves to its main
  repo's name through git-common-dir, because seat worktrees live at
  `~/.agent-bus/worktrees/<project>/<agent>` and the plain basename named the project after the
  agent. An explicit `RELAY_PROJECT` always wins; the hub folds aliases on top.
- A project lives on exactly ONE hub (TDD §12.1). Resolution: `RELAY_URL` env, then config
  `hubs[project]`, then the legacy global `url`, then the local default. Never throws.
- Provenance is part of the answer: `via` is `env`, `pin` (the only deliberate routing), `global`
  or `default`, so sessionstart, doctor and `relay_whoami` can warn when a project silently fell to
  the fallback hub, the most expensive failure this system has.
- Split-brain detection (`lib/splitbrain.mjs`) probes every hub the machine knows and compares the
  live rosters with the pins. An unsigned read of an enforce hub answers 401, and `(body.peers ||
  [])` would turn that into a confident empty list, so `probeHub` reports a REASON and `analyze`
  carries unreadable hubs through as `blind`; a partial answer can never print as a clean bill.
- A non-seat directory must never register (`seatDisqualifier`): it mints a phantom board
  (`<username>`, `development`) that lands unpinned on the local hub while the crew is on the
  remote one. A workspace container such as `~/development` is the worst case; a plain non-git
  directory is not disqualified. An explicit `RELAY_SESSION`/`RELAY_PROJECT` is the opt-in.
- Declared seats (`lib/seats.mjs`): a reboot reopens every window in `$HOME` and every seat quietly
  becomes a non-seat. The operator declares once which project lives in which directory, and a seat
  is live only when a real process is STANDING IN ITS DIRECTORY (`ps` plus `lsof`, bounded,
  fail-soft), never by the hub's presence list, because a name is assertable and a cwd is not.
- The bus directory is resolved in one place and honours both `AGENT_BUS_DIR` and `RELAY_DATA_DIR`;
  a reader that honours neither mutates the user's real state during a drill.
- The orchestrator-session map is one TAB-separated row per project, shared by `trantor open`,
  `trantor adopt` and the hooks, and updated across a handoff so `open` never resumes a dead thread.
  Whether the session writing a handoff IS the orchestrator thread is decided by evidence:
  `TRANTOR_ORCH` matching the project, else the recorded thread's transcript freshly written.
- Machine identity: `os.hostname()` changes with the network and forks one Mac into two bus
  identities, so the id is resolved once (`RELAY_HOST_ID`, then the persisted id, then macOS
  LocalHostName, then hostname without domain) and persisted to `~/.agent-bus/machine-id`.
- Env-file precedence (`withEnvFiles`): files are prepended, so the last prepended runs first and in
  shell the last run wins. Callers pass files highest priority first (crew layer, then fallbacks).
  Getting it backwards once handed every crew seat Scrooge's key; `test-crew-env.mjs` proves it
  against a real shell. `lib/provider-keys.mjs` resolves keys the same way (`~/.token-scrooge/.env`,
  then `~/.agent-bus/.env` which wins, over `process.env`).

## Autonomy (`lib/autonomy.mjs`)

- Three dials, not one: `harness` (does the operator's own claude ask), `acts` (what Trantor itself
  does: commit, push, deploy, swap, retry) and the crew-agent dial, which is the overseer's
  per-project level on the HUB because it is shared team state. The file is shared state on purpose:
  the app writes it, `crew.mjs` and the runner read it.
- `handoff`: "ask" (default) lets the app's banner ask and the heartbeat neither arms nor fires;
  "auto" arms at the warn line and fires at the turn boundary (#5509, SYSTEM-CONTRACT §5).
  PreCompact backstops both modes.
- Dependencies are enforced on READ: push implies commit, deploy implies push, so a hand-edited file
  cannot smuggle a state the UI would refuse.

## Overseer warnings

- Linked projects: a link is DECLARED, so two live sessions on both sides is a permanent state and
  never a warning (#7029). Only an event warns: one file path claimed live from both sides, or one
  card held (doing/testing) by live sessions from both sides, where `workedBy` is the signed
  evidence. This under-warns by construction.
- Same-project sessions (`lib/same-project.mjs`, #5760): an episode, not a timer. The warning fires
  once when the membership set changes (keyed by a hash of the set), reports duration rather than
  repetition, and only sessions outside the operator-declared crew count. Pure module; the hub owns
  persistence.
- Duty nudges (#7131): an escalation is dropped when its recipient already read the message, because
  a nudge wakes a session and every wake costs a turn on both sides. `isDelivered` is injected; the
  runner passes a `/peer` lookup (singular: `/peers` omits `deliveredUpTo`). Unknown never counts as
  delivered.

## Crew turn policy and failure classification

- `lib/turn-policy.mjs` (#6134) decides whether a message is worth a turn, which card a session
  binds to, what a turn cost and when an exhausted seat may wake. The card a wake binds to is read
  by SHAPE, an assignment verb or label immediately before the id, never by position (#7061):
  direct messages outrank @mentions, the newest assignment wins, and only an assignment-free batch
  falls back to the newest message's first citation.
- Cross-project wakes (#6228): same project always passes; a declared `trantor policy link`
  (mirrored to seats through `GET /policy`) opens two named projects; anything else is dropped.
- `lib/classify-failure.mjs` (#5868): a prompt line reappearing in the err stream is the CLI
  replaying what it was told. Both sides are normalised (ANSI stripped, whitespace collapsed) and a
  line is dropped when it contains a prompt line of 40+ chars, is a fragment of one, or shares a
  40-char run with one; short lines are checked verbatim (#6110). `looksLikeAuthDeath` fires only
  on a short error-only output and never when the turn produced a new commit. "exhausted" demands an
  explicit quota or rate-limit message.
- `lib/seat-why.mjs` diagnoses a seat from local evidence in order: the err log, the runner
  telemetry, the pane record, live runner processes. States: live, dead-quota, dead-auth,
  dead-crash, no-runner, no-pane.

## Providers and balances

- `lib/providers.mjs` (#6390) is the one truth for "is this provider ready to seat", built on
  Orca's pattern: PATH detect, the CLI's own login command and credential artifact, and connected
  means a live usage call succeeded. The JSON row shape is FROZEN for the Accounts pane (#6391) and
  the wizard (#6392): `{ provider, label, kind, connect, binary:{name,installed,path},
  auth:{artifact,present,mode}, state, reason, usage, actions }`, with `state` one of connected,
  not_installed, not_logged_in, expired, over_quota, unknown and always a non-empty reason. Probes
  are never duplicated: every live check is a `lib/balances.mjs` adapter.
- Claude's OAuth token is read from `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR`) and then
  the keychain item "Claude Code-credentials", attribute-only and only when the caller did not
  inject a home, so a health read never raises a secret prompt and drills stay hermetic.
- A provider with no auth at a known location is not_logged_in; one whose artifact cannot be read
  (agy) is unknown with the how-to-check in the reason.
- `lib/balances.mjs`: keys come from the environment; prepaid providers report a balance, quota
  providers a `remainingPct` plus `resetTime`. International endpoints only. Every call is
  short-timeout and fail-soft. The hub runs under launchd without keys, so env-having clients fetch
  and POST `/balances`. Balances are queried only for providers in the user's profile.
- Claude usage: the statusline sidechannel keeps a live local cache that answers when the OAuth
  endpoint 429s under polling (docs/RESEARCH-orca-usage.md §1.1); OAuth stays primary because only
  it carries the model-scoped window. Scoped weekly limits in `limits[]` are their own segment; the
  session and weekly_all entries there duplicate five_hour and seven_day.
- Qwen token plan (#6131): the graded gauge is cookie-only, so the adapter reads the WALL, a 429
  insufficient_quota with the reset time once the plan is spent, and reports unknown otherwise. The
  empty-messages probe costs no tokens because the quota gate runs before request validation.
- Codex (#5570): the Codex CLI's own token reads the ChatGPT usage windows; the token never leaves
  the process and only percentages are reported. Unreachable falls back to the flat subscription
  row, never an error row. Profile-gated like every adapter: no profile, no row.

## Redaction and scrubbing

- `lib/redact.mjs` (#5869) scrubs known key shapes before bytes land in the seat's err log:
  `sk-…` (`<redacted:SK>`), `AIza…`, `xai-…`, `ghp_…`, `<VAR>_KEY=`/`<VAR>_TOKEN=` with a 32+ char
  value (the name is kept), and `Authorization: Bearer …`. Ordinary lines are byte-identical and the
  function is idempotent. The tee replacement (`--tee`, `--tee2`) echoes verbatim to the window and
  appends redacted bytes line-buffered, since a chunk can split a match but keys never span lines.
- `lib/scrub.mjs` protects the append-only event log. A 64-char hex string is also the shape of a
  pubkey and a sha256 digest the protocol emits constantly, so a private-key match requires an
  intent word within the preceding 40 chars.

## Store contract and Postgres store

- The EVENT LOG is the table; board state is a projection of it. Every field of hub state must
  round-trip, including the ones the SQLite store kept in memory (verifyGates, balances, handoffLog,
  aliases, phaseMeta, focus).
- kv keys that must round-trip: `proposals` (a denied proposal is a memory the hub refuses
  re-proposals against) and `contractReap` (forgetting it re-announces the ghost backlog).
- Invariants carried from 0.17.54: card events keep the legacy flat shape and type names
  (`created`/`moved`/`updated`, never dotted); message events carry `refs[]`, never `task_id`;
  threads are derived, never stored; the delivery ledger `delivered_up_to` is monotonic; retention
  is time-based and never deletes a projection row.
- Cross-writer protocol: every writer NOTIFYs the change channel after a committed write with
  `{"src":"<writer-id>"}`; the hub LISTENs and reloads on a foreign src.
- `lib/store-pg.mjs`: the columns are the truth, so the payload is spread FIRST and columns after. A
  stored `id` spread last once shadowed the row id and silently stalled the append-only log for 18
  days. `saveDelta` touches only rows the hub has seen (`diffById`), so an external writer survives
  and the hub stops rewriting every row per tick; events stay `INSERT … ON CONFLICT DO NOTHING`,
  and NOTIFY fires inside the transaction.

## Integration and sub-agents

- The integration pass (`lib/integrate.mjs`) automates what the orchestrator did by hand: collect
  seat branches, check for collisions, prove, push. Every stage can refuse and reports why. Seat
  work is committed AS THE SEAT so git blame stays the durable answer; a merge conflict is aborted
  and reported, never left half-done.
- `lib/subagent-manifest.mjs` is a read-time projection of a session's sub-agents from on-disk
  transcripts (`subagents/*.meta.json`, the parent jsonl for which agents returned, each agent's
  jsonl for what it wrote, and a disk reconcile for whether that survived). It exists because a
  successor once rebuilt a finished agent's work believing nothing survived a kill.
- `lib/subagent-scan.mjs` recomputes notional sub-agent cost for `trantor recost`: only transcripts
  still on disk count, unknown models price as null, and implausible transcripts are counted but
  their cost dropped.

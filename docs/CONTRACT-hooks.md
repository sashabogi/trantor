# Contract: the Claude Code hooks (`hooks/`)

Every hook runs inside the operator's tool loop. These are the seams the hooks hold; the
incident stories are on the cards named here.

## Fail-open, cheap, own-harness only

- A hook never throws and never hangs: every network call has a short timeout, every export in
  `hooks/lib/*` resolves to `{}` / `[]` / `""` on error, and stdout is always valid JSON. A hook
  that breaks a session is worse than a hook that does nothing (acceptance §9 #10).
- A session is reached only through its own harness: its own hook reads its own inbox and hands the
  text to its own model as `additionalContext` or a Stop `decision:block`. Nothing reaches across a
  process boundary. Typing into another session's terminal was removed for good: `/send` is
  self-asserted, so any local process could have aimed keystrokes at a bypass-permissions agent.
- A hook that only wants to say something returns no `permissionDecision`. Returning `allow` to
  carry a warning approves the tool call and overrides the operator's own permission rules
  (file-claim, #5391 lineage).
- Per-session stamp files throttle every network call (heartbeat, inbox poll, claims, update
  check). The first touch of a file always posts a claim; that is the moment a collision matters.

## The signed client (`hooks/lib/api.mjs`, TDD §8)

- One client for every hook and the MCP server. Writes are signed (Ed25519, TDD §7.3) so `/send`'s
  `from` cannot be forged. Reads stay unsigned by default: signing `/peers` and `/catchup` scopes
  them to the reader's own project and kills cross-project discovery. `signedGet` exists for reads
  that must survive `RELAY_AUTH=enforce` (overseer context, sessionstart's roster and handoff).
- Hub URL is per project (TDD §12.1): `RELAY_URL`, then `config.hubs[project]`, then `config.url`,
  then `127.0.0.1:4477`. The project a request is about travels with the request (explicit, then
  payload, then query, then cwd); the hook process's own cwd is the last resort, not the first.
- Enrollment (`/enroll`, TDD §7.4) is once per key, stamped locally, best-effort. Sessions not
  spawned by the runner enrol through `lib/enroll.mjs` with an operator-minted invite (#6270), and
  a failure lands in the banner and the model's context, never only on stderr.
- A read that never got an answer returns `status: 0` plus `timedOut` and `reason`: a timeout and
  an outage need opposite responses (#7037, #6983).
- `hubCallSync` returns `{ ok, status, json, reason }` and never a bare list: a 401 body is valid
  JSON and an auth refusal must not be spellable as an empty result (#7037).

## Identity and project

- Identity is `RELAY_SESSION`, then `RELAY_AGENT:project`, then `hostId:project`, exactly as
  `mcp.mjs` derives it. `hostname()` drifts across networks and `basename(cwd)` forks a subdirectory
  into its own lane; use `hostId` and `resolveProject` (git root).
- The relay MCP server resolves its project once at start; hooks resolve per call. A mid-session
  `cd` across projects makes the two disagree (reads as one identity, sends as another). It cannot
  be repaired from the hook, so it is said once with the two ways out.
- A session started outside a project (home, a folder of projects, the plugin cache) is not a seat:
  no registration, and an unmissable explanation in both the banner and the model's context.
- `TRANTOR_ORCH=<project>` marks the orchestrator pane. Its peer row is registered `kind: "orch"`
  on a strict badge match (#6075), and it receives the orchestrator doctrine at every boot,
  including the dispatch rule: confirm the target project from badge and cwd before any dispatch,
  never wake a session that is asking the operator a question (#6226).

## Inbox delivery and the Stop hook

- `inbox-deliver` (PostToolUse) reaches a busy session mid-turn; `stop-inbox` (Stop) covers the
  moment it is about to go idle. Both drain stdin fully (a large tool input blocks the parent's
  pipe otherwise) and keep the bytes: `session_id` keys the per-instance cursor
  (`docs/INSTANCE-KEYS-CONTRACT.md`) and `cwd` names the project.
- The inbox ledger anchors its cursor to session start, never to the first successful poll: a start
  stamp is written before any network I/O, and a late seed splits backlog from mail that arrived on
  this session's watch. Compaction keeps the session id, so an existing ledger is left alone.
- Stop rules: direct messages only; `stop_hook_active` always allows; delivery is claimed only once
  the block is decided; any error allows the stop. A `stalled` contract the session dispatched
  blocks once; `abandoned` never blocks (the dispatcher was told while it was stalled).
- A Stop is the turn boundary. A baton armed mid-turn fires here, detached, with the arm cleared
  first. A boundary is only a boundary when nothing is still running (#6528): with a sub-agent in
  flight the arm stays, and the heartbeat's hard cap keeps a never-idle session from staying armed.

## The baton (heartbeat, precompact, `hooks/lib/handoff.mjs`)

- The heartbeat is PostToolUse, so it can only ever run mid-turn. It ARMS; the Stop hook FIRES.
  Arming is cheap and idempotent and does not mark handed-off; the in-flight debounce guards the
  spawn only. The window id and tty are captured at arm time because the detached worker has no tty.
- The one in-flight gate (`#6528`): a recently written sub-agent transcript, or a transcript tail
  whose last row is anything but a text-only assistant row, means mid-turn. Only an operator's typed
  command or `--force` bypasses it. A session with no live process (`~/.claude/sessions`) is at its
  boundary (#6668); the "dead" verdict needs another live entry so an old Claude Code does not turn
  every mid-turn handoff into an immediate write.
- Never arm mid-build: `subagentsActive()` defers, and the next heartbeat re-checks.
- An automatic baton never closes the original session. Auto-close is opt-in
  (`config.autoCloseOriginal: true`); a manual `/trantor:handoff` closes non-destructively (never
  SIGKILL, aborts if the original is busy). Resolve the original window BEFORE spawning the fresh
  one, or the successor closes itself.
- Spawn suppression honours both `TRANTOR_NO_HANDOFF_SPAWN` and `TRANTOR_NO_BATON_SPAWN` everywhere
  a window is opened, and reads the injected env as well as the real one so a drill can say no.
- Surface resolution (#6074, #6218): `HERDR_PANE_ID` means the pane leg keyed by that pane, with the
  window machinery forbidden. The registered project name wins over a subfolder cwd of the same
  project; a badge pointing at a foreign directory does not relabel the handoff, and one warning
  line names both. `resolveHandoffSurface` is the single resolver for the skill path and the CLI.
- Writer discipline (#5648): the digest is capped at ~4KB on paragraph boundaries keeping both ends;
  the raw tail is cut on a turn boundary; the structured `state` field rides beside `summary`,
  validated and never capped (TDD §4.5); attaching state never blocks a handoff. A fresh
  model-authored handoff is never superseded by an automatic digest.
- The card a handoff belongs to: `TRANTOR_CARD` wins, else `/catchup` (not `/tasks`, #7037), with a
  truncated bucket reported as unknown rather than 0. Open verify gates travel with the record and
  an unreadable list is reported, not rendered as none.
- The hub's storm guard rate-limits non-forced handoffs per project and session; fail-open.
- Context window: the transcript never carries the `[1m]` marker, so `RELAY_CONTEXT_WINDOW` or
  `config.contextWindow` must declare it (Fable is the known 1M exception, #5503). The poison guard
  reads the same fixture manifest as the desktop gauge (#5572).
- `scrooge` is resolved to an absolute path (`~/.local/bin` is not on a hook's PATH).
- osascript gets multi-line scripts on stdin, never `-e`.

## Session start

- Handoff files match `^<project>-<digits>\.json$` and sort by the numeric stamp.
- A `compact` start never claims (it is the writer); a `resume` never claims (its window never
  reset). A handoff written by the recorded orchestrator thread is held for the orchestrator pane
  for a window (default 30 minutes) before first-fresh-session-wins applies.
- Claiming records who took over and arms the recap net (SYSTEM-CONTRACT §5): every prompt before
  the first Stop carries the recap reminder, and the first Stop marks RECAPPED.
- The injection is a pointer, not a payload: capped at 4KB on a line boundary with the verbatim
  tail stripped, pointing at the record file and transcript (#5645).
- Boot inventories live crew resources and steers toward adopting them; the dead-row cleanup runs
  detached (intersession ops #4214/#4215). Provably dead = no live process, no heartbeat, no owning
  session; nothing in `hooks/lib/resources.mjs` ever kills a process.
- Active grants are injected at every boot so a recorded operator decision outlives the DM it came in.
- The update check is throttled (6h TTL), shown as an in-terminal `systemMessage`, desktop
  notification opt-in (`config.updateDesktopNotify`), disabled by `TRANTOR_NO_UPDATE_CHECK`.
- The session title is `<project> · <current work>` so concurrent sessions are distinguishable.

## Board hooks

- `prompt-focus`: one rolling focus card per session, heuristic title on the turn path, a detached
  rewrite by a cheap model afterwards. Never an LLM call on the turn path.
- `subagent-start` serves PreToolUse (creates the in-flight card, has the prompt) and SubagentStart
  (enriches with `agent_id` and parent); `subagent-cost` closes it with the notional API cost read
  from the sub-agent's own transcript. `agent-notify` cards CC's background agents as
  `cc-bg-agent`, a distinct population, and dumps the raw payload under `TRANTOR_DEBUG_NOTIFY=1`.
- `statusline` forwards the Claude usage blob to `/usage/claude`, signed, at most once per 15s, and
  prints nothing.
- `overseer-warn` narrates what `GET /overseer/context` already computed
  (`docs/OVERSEER-CONTRACT.md`), informational below level 3, never blocking.

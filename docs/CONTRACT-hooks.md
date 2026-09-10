# Contract: the Claude Code hooks (`hooks/`)

Every hook runs inside the operator's tool loop. Card #6450 moved these contracts here from
comments; the incidents behind them live on the cards linked below.

## Fail-open is a contract (acceptance §9 #10)

- A hook never throws and never hangs. Every hub call has a short timeout (1.5 to 2.5 seconds) and
  resolves to `{ ok:false, status:0, json:null }` on any failure. The caller proceeds as if the hub
  were silent. `hooks/lib/api.mjs` is the one client every hook uses; `timedOut` and `reason` are
  additive on the failure shape so a timeout (retry) and an outage (investigate) stay distinguishable.
- A hook that only wants to SAY something returns no `permissionDecision`. `additionalContext`
  reaches the model on its own; an "allow" would bypass the operator's Edit/Write rules
  (`hooks/file-claim.mjs`).
- Every subprocess in `hooks/lib/resources.mjs` has a 2 second ceiling and nothing there kills a
  process; `cleanDead()` prunes tracking rows only.

## Signing

- Writes are signed (Ed25519) through `signedPost`, which closes the self-asserted `from` hole.
- Reads default to unsigned `getJSON` because signing `/peers` and `/catchup` scopes them to the
  reader's own project and breaks cross-project discovery. Project-scoped reads that must work under
  `RELAY_AUTH=enforce` use `signedGet` (`/overseer/context`, the sessionstart roster and handoff reads).
- `hooks/lib/handoff.mjs` runs synchronously, so its hub calls go through `hubCallSync`, which
  returns `{ ok, status, json, reason }` and never a bare list (#7037). A 401 body is valid JSON and
  must not be readable as an empty result.
- Enrollment is best-effort and once per key (TDD §7.4). On an enforce hub `hooks/sessionstart.mjs`
  enrols through `lib/enroll.mjs` with an operator-minted invite before the first read (#6270), and a
  failure lands in the banner and the model's context.
- The hub URL is per project (TDD §12.1): env `RELAY_URL`, then `hubs[project]` in the shared config,
  then the legacy `url`, then `127.0.0.1:4477`. The project a request is ABOUT travels with the
  request: explicit, then payload, then query, then cwd.

## Message delivery through the session's own harness

- `hooks/inbox-deliver.mjs` (PostToolUse) and `hooks/stop-inbox.mjs` (Stop) are the only delivery
  paths. Both read the session's own inbox and hand the text to its own model as
  `additionalContext` or a Stop `block` reason. Nothing ever drives another session's terminal.
- The inbox cursor seeds at SESSION START (`hooks/lib/inbox-ledger.mjs`, #7282), never at the first
  successful poll. The start stamp is written before any network I/O. Compaction keeps the session
  id, so an existing ledger is left alone.
- Stop rules: direct messages only; `stop_hook_active` always allows; a message is claimed only
  after the decision to surface it; any error allows the stop. A contract the hub calls `stalled`
  blocks the stop once; `abandoned` never blocks.
- PostToolUse stdin is drained and kept: `session_id` keys the per-instance cursor and `cwd` names
  the project. The relay MCP resolves its project once at start and cannot see a later `cd`; the
  hook reports that drift once.

## The baton (handoff)

- The heartbeat runs mid-turn, so the warn threshold ARMS and the Stop hook FIRES at the turn
  boundary. Arming is idempotent and does not `markHandedOff`; marking happens where the baton fires.
- The one in-flight gate (#6528): `subagentsActive()` and the transcript tail. Only a text-only
  assistant row reads as idle; a trailing user row of any kind means in flight. Every path that can
  write and spawn a handoff asks this gate; only a typed operator command or `--force` bypasses it.
  A session whose process is gone (`~/.claude/sessions/<pid>.json`, #6668) is at its boundary.
- An automatic baton never closes the original session. Auto-close is opt-in through
  `config.autoCloseOriginal`; the manual `/trantor:handoff` closes non-destructively.
- Resolve the original window BEFORE spawning the fresh session; reversed, the successor closes
  itself. `TRANTOR_NO_HANDOFF_SPAWN` and `TRANTOR_NO_BATON_SPAWN` are both honoured everywhere a
  window can open, and a drill may pass its own env.
- Where a session lives is read from its own env first (`HERDR_PANE_ID`, #6074), then the
  registration chain, then cwd. The badge wins only when the cwd lies inside the named project or
  one of its worktrees (#6218). A hosted orchestrator pane is the successor surface (#5509 W1,
  #5643) and the handoff waits for it.
- Writer discipline (#5648): the inline summary is capped at about 4 KB on paragraph boundaries,
  keeping both ends. The structured `state` field (TDD §4.5) is validated and never capped. A fresh
  model-authored handoff is never superseded by an automatic digest.
- Reader discipline (#5645): the injection is a pointer, capped at 4 KB, with the verbatim tail
  stripped. A compaction start shows a pending handoff without claiming it; a resumed session never
  claims. An orchestrator's baton is held for the orchestrator pane for 30 minutes, then lapses.
- Claiming records who took over and arms the recap net (SYSTEM-CONTRACT §5): every prompt before
  the successor's first Stop carries the recap reminder.
- The card a handoff belongs to comes from `TRANTOR_CARD`, else `/catchup` on a 2 second budget
  (#7037); a truncated bucket reports UNKNOWN, never 0. Open verification gates ride the record as
  structure, and an unreadable list is reported rather than rendered as zero gates.
- The context window cannot be read from the transcript; `RELAY_CONTEXT_WINDOW` or
  `config.contextWindow` declares it, Fable is the known 1M exception (#5503), and the #5572 poison
  guard reads the same fixture manifest as the desktop gauge.
- The server-side storm guard asks the hub for clearance on non-forced handoffs and fails open.

## Presence and the board

- The heartbeat refreshes `lastSeen` on every tool call, throttled by a stamp file, and posts
  `/register` without a status field so the meaningful status survives.
- `hooks/sessionstart.mjs` refuses to register a session outside a project and says so to both the
  user and the model. It stamps `kind: "orch"` only when the `TRANTOR_ORCH` badge equals the project
  (#6075), injects the operator's standing grants, steers the session toward adopting a live crew
  (#4215), and delivers the orchestrator doctrine with the target-project dispatch rule (#6226).
- Sub-agent cards: PreToolUse creates the in-flight card with the prompt title; SubagentStart
  enriches it with `agent_id` and parent; SubagentStop posts the notional cost. Background agents
  are carded as `cc-bg-agent`, a distinct population.
- The focus card is one rolling card per session, titled without an LLM call on the turn path.
- Identity is resolved exactly as `mcp.mjs` does: git root for the project, the stable machine id
  for the host.

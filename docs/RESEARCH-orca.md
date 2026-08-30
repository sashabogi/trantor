# Orca (stablyai/orca) code-read — P0c, card #5577

Source: shallow clone of github.com/stablyai/orca (57.3k stars, MIT, Electron, TypeScript).
All paths below are repo-relative. Read 2026-08-30.

## 1. Conversation binding

Orca does NOT parse PTY output for chat. The PTY is display + input only. Binding is a
three-legged design: injected env identity -> managed hooks report back -> transcript tailing.

- **Identity injection**: every agent pane's PTY gets `ORCA_PANE_KEY`, `ORCA_TAB_ID`,
  `ORCA_WORKTREE_ID`, `ORCA_AGENT_LAUNCH_TOKEN`, `ORCA_AGENT_HOOK_PORT/TOKEN/ENDPOINT`
  (`src/main/agent-hooks/hook-stdin-contract.ts:37`, `src/main/agent-hooks/server.ts:3141`).
- **Managed hooks**: Orca installs hook commands into each agent's own hook system (for Claude:
  SessionStart, UserPromptSubmit, Stop, SubagentStart/Stop, Pre/PostToolUse, PermissionRequest —
  `src/main/claude/hook-settings.ts:36`). Hooks POST the stdin payload (which carries
  `session_id` + `transcript_path`) to a localhost HTTP server on a random port
  (`server.ts:2667,2690` — `createServer(...).listen(0, '127.0.0.1')`), authenticated by token.
  The current port is also written to an **endpoint file** on disk so hooks in shells that
  outlive an app restart can re-find it (`server.ts:2563`, `src/shared/agent-hook-endpoint-file.ts`).
  If the POST fails, hooks append to a durable **spool file** (`spool/pane-<id>.jsonl`) replayed
  later (`hook-stdin-contract.ts:28-69`, `src/main/agent-hooks/spool.test.ts`).
- **Chat rendering = transcript tailing**: the hook-reported `transcript_path` is authoritative;
  fallback is a glob of `~/.claude/projects/<slug>/<id>.jsonl` (Codex: rollout-file suffix match,
  plus Grok/OMP layouts) — `src/main/native-chat/session-file-resolver.ts:97-147`. Tailing via
  `transcript-tail-reader.ts` / `transcript-watch-engine.ts` with per-agent JSONL line decoders
  (`transcript-line-decoders-{claude,codex,grok,omp}.ts`). Claude branch/resume correctness is
  proven by a leaf-UUID check (`src/main/claude/claude-transcript-branch-proof.ts`).
- **Restart survival**: provider session metadata (key `session_id`, id, transcriptPath) is
  captured from hooks and persisted; cold pane restore issues `claude --resume <id>` (per-agent
  resume argv in `src/shared/agent-session-resume.ts:251-257`; Pi resumes by transcript file).
  A second, newer "structured" runtime drives Claude via stream-json frames / Codex via
  `codex app-server` JSON-RPC, with a durable per-session journal under
  `userData/agent-session-journal/<hash(workspace)>/<hash(session)>`
  (`src/main/native-chat/agent-session-journal/journal-paths.ts:27`) and a lease/ownership store
  `agent-sessions.json` with PID-reuse-safe identity (pid + start time + spawnToken env) and
  atomic temp-write/fsync/rename (`src/main/runtime/agent-session-record-store-file.ts`,
  `src/shared/agent-session-record.ts:60-128`).
- **Rate-limit sidechannel**: Orca also installs a managed Claude **statusline script** that
  POSTs the `rate_limits` JSON Claude Code (>=2.1.80) pipes to statusline commands to
  `/statusline/claude` on the hook server — zero extra API calls
  (`src/shared/claude-statusline-rate-limits.ts:1-10`, `src/main/claude/statusline-script.ts`).

Versus our design: herdr pane-reported identity + transcript tailing is the same shape as
Orca's legs 1+3. What we lack is leg 2 — hooks echoing identity back with `transcript_path`,
with endpoint-file + spool durability.

## 2. Diff annotations -> prompt

- **Data model**: `DiffComment { id, worktreeId, filePath, startLine?, lineNumber, body,
  scope: unstaged|staged|branch, diffIdentity?, sentAt?, side: 'modified' }` —
  `src/shared/diff-comment-types.ts:27-48`. Stored on WorktreeMeta, persisted automatically to
  `orca-data.json` (comment at `diff-comment-types.ts:1-5`). `sentAt` marks a note as delivered;
  editing clears it.
- **Serialization**: deterministic plain text, one block per note:
  `File: <path>\nLine: N` (or `Lines: A-B` / `Scope: file`) `\nUser comment: "<escaped>"`,
  blocks joined by blank lines — `src/shared/diff-comments-format.ts:9-34`. That string IS the
  prompt; there is no structured protocol to the agent.
- **Delivery**: a "send notes" menu builds the prompt per scope (this file / all unsent) —
  `src/renderer/src/components/editor/DiffNotesSendMenu.tsx:56-84` — then routes through the
  agent-send popover to any running agent pane of the worktree; the text is **bracketed-pasted
  into the agent's PTY** and submitted after a delay
  (`src/renderer/src/lib/active-agent-note-send.ts`, `src/renderer/src/store/slices/ui.ts:1153-1232`).
  Alternative path: bootstrap a brand-new agent session with the notes as the opening prompt.
  On confirmed delivery, `sentAt` is stamped (`clearDeliveredDiffComments`).

## 3. Usage footer

All of this lives in `src/main/rate-limits/` (one fetcher per provider, orchestrated by
`service.ts`, 77KB).

- **(a) Claude plan windows — YES, exactly the endpoint we suspected**:
  `GET https://api.anthropic.com/api/oauth/usage` with headers
  `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`,
  `User-Agent: claude-code/2.1.0` — `claude-oauth-usage-request.ts:8,72-79`. Response fields:
  `five_hour`, `seven_day`, plus Fable-scoped `limits[] {kind:'weekly_scoped', percent,
  scope.model.display_name:'fable'}` (lines 19-53). The token is Claude Code's own OAuth
  credential: macOS Keychain first (scoped then legacy), then `~/.claude/.credentials.json`
  `.claudeAiOauth.accessToken` — `claude-oauth-credentials.ts:104-148`. Fallback ladder when
  OAuth fails (`claude-active-usage-fetch.ts`): retry legacy keychain -> delegated credential
  refresh -> spawn the `claude` CLI in a hidden PTY and parse `/usage` output
  (`claude-cli-usage-fetch.ts`, `claude-pty-usage-parser.ts`). Steady-state refresh piggybacks
  on the statusline sidechannel (sec. 1) because the OAuth endpoint 429s under polling.
- **(b) Codex — the numbers come from the codex CLI itself plus a ChatGPT backend endpoint**:
  1. Primary: spawn `codex -c approval_policy=never -s read-only -a never app-server` and
     JSON-RPC `initialize` -> `account/rateLimits/read`
     (`codex-fetcher.ts:95-125`, `src/main/codex-cli/codex-read-only-app-server-args.ts`,
     `codex-rpc-rate-limit-probe.ts:220-245`).
  2. Fallback: run `codex` in a hidden PTY and parse the TUI status output
     (`codex-pty-rate-limit-probe.ts`, `codex-pty-status-parser.ts`).
  3. Supplement/direct: `GET https://chatgpt.com/backend-api/wham/usage` with
     `Authorization: Bearer <tokens.access_token from ~/.codex/auth.json>`,
     `ChatGPT-Account-Id: <tokens.account_id>`, `User-Agent: codex-cli`,
     `OpenAI-Beta: codex-1`, `originator: Codex Desktop` —
     `codex-backend-usage-client.ts:68`, `codex-backend-auth.ts:74-98`. Returns `plan_type`
     and `rate_limit.primary_window/secondary_window {used_percent, limit_window_seconds,
     reset_at}` — that is where the ~61%/25% numbers come from. So: NOT a public OpenAI API;
     it is the ChatGPT internal backend, authorized by the Codex CLI's own OAuth token file.
- Same per-provider pattern exists for Gemini, Grok, Kimi, MiniMax, opencode
  (`gemini-usage-fetcher.ts`, `grok-fetcher.ts`, `kimi-fetcher.ts`, ...).

## Copy vs skip (for our Tauri app)

**Copy**
- The Claude OAuth usage call verbatim (endpoint, beta header, keychain -> credentials-file
  token ladder) — directly closes card #5570 for Claude.
- The Codex `~/.codex/auth.json` + `chatgpt.com/backend-api/wham/usage` call — closes #5570
  for Codex without shipping a PTY probe.
- The statusline sidechannel: `rate_limits` piped to statusline is a free, per-turn usage feed
  and avoids 429s from polling the OAuth endpoint.
- Hook-reported `transcript_path` as the authoritative chat binding, with id-glob fallback —
  strictly better than our session-id-only tailing; the leaf-UUID branch proof is worth porting.
- Endpoint-file + spool-file durability for hook delivery (survives app restarts and offline
  windows); we have the same seam-failure class on our bus.
- Diff-note -> plain-text prompt with `sentAt` bookkeeping: trivially portable, no protocol.

**Skip**
- The structured runtime + lease/journal machinery (agent-session-record store, fences,
  handoff adjudication): thousands of lines of Electron-process-model insurance; herdr already
  owns process lifetime for us.
- WSL relay/translation layers (~40 files) — not our platform matrix.
- Electron `net.fetch`/proxy handling — Tauri's HTTP plugin replaces it.
- Hidden-PTY fallback probes (claude `/usage`, codex TUI parse) — brittle; only add if the
  HTTP endpoints prove insufficient.

## Could not determine

- Whether `chatgpt.com/backend-api/wham/usage` is stable across ChatGPT web releases — no
  version pinning or fallback URL in the repo; Orca hedges with the RPC/PTY paths.
- Server-side rate-limit policy on `api.anthropic.com/api/oauth/usage` (Orca's comments say it
  429s "under Orca's polling" but the safe interval is not stated; they moved to the
  statusline sidechannel + refresh planner `claude-usage-refresh-plan.ts`).
- Exact write path/schema of pane->providerSession persistence in `orca-data.json` (spread
  across the 139KB `agent-hooks/server.ts` "last status" hydrate/write; not fully traced).
- Mobile/VPS ("orcad") variants of the binding — `src/main/orcad/`, `mobile/` not read.

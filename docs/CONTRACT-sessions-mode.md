# Sessions mode contract

Card #5842. This is the evidence and behavior contract for the Code lens's **Sessions**
mode. The implementation reads each harness's own durable transcript store; it does not
reconstruct history from relay messages or invent a common upstream format.

## Stores verified on this machine

The following paths and shapes were observed directly on 2026-09-01:

| Harness | Durable store | Verified shape used by Trantor |
|---|---|---|
| Claude Code | `~/.claude/projects/<slugified-cwd>/*.jsonl` | Top-level `type: user|assistant`, `cwd`, `gitBranch`, `sessionId`; content and model/usage under `message`. |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `session_meta.payload` owns `id`, `cwd`, and `git.branch`; `turn_context.payload` owns the current model; `response_item.payload` owns user/assistant content. |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite tables `session`, `message`, and `part`. Session directory/model/time are columns; role and text are JSON fields in `message.data` and `part.data`. The adjacent `-wal`/`-shm` files confirm the database is live, so reads use SQLite rather than copying the main file. |
| Kimi Code | `~/.kimi/sessions/<md5(cwd)>/<session-id>/context.jsonl` | Context rows carry `role` and `content`; sibling `wire.jsonl` is protocol traffic and `state.json` is UI/session state. The cwd hash was verified by comparing the directory name with `md5(cwd)`. |

OpenCode's older `~/.local/share/opencode/storage/` directory exists, but the current
session records are in `opencode.db`; treating the legacy directory as the source would
silently omit current sessions. Kimi's `~/.kimi/user-history/` also exists, but the
user+assistant conversation is in `sessions/.../context.jsonl`.

## Normalized row

`sessions_list(project, scope)` returns rows sorted newest first:

```text
id, harness, title, lastMessage, messageCount, model, branch, updatedAt, cwd
```

- `title` is the first non-empty user message. OpenCode's generated `session.title` is
  only the fallback when no user text part exists.
- `lastMessage` is the last non-empty user or assistant text.
- `messageCount` counts user+assistant message rows, not tool parts.
- Claude's model comes from the last assistant row that also carries `usage`, and its
  branch comes from `gitBranch`.
- Codex's model comes from the last `turn_context`; its branch comes from
  `session_meta.payload.git.branch`.
- OpenCode's model comes from `session.model.id`. Its checkout badge comes from a
  factual `.agent-bus/worktrees/<project>/<seat>` directory when present.
- Kimi does not persist the selected model or historical git branch in the verified
  `context.jsonl`, `wire.jsonl`, or `state.json` rows. Those fields stay unavailable;
  the UI says `model unavailable` rather than guessing `kimi-code/k3`.
- `updatedAt` is transcript mtime for file stores and `session.time_updated` for
  OpenCode.

## Scope

- **Worktree**: the canonical checkout at `$TRANTOR_DEV_ROOT/<project>` (default
  `~/development/<project>`) and its children.
- **Project**: Worktree plus every checkout below
  `~/.agent-bus/worktrees/<project>/`.
- **All**: every discovered row in all four stores. A row from All remains openable even
  when it belongs to another project; the opaque session id is resolved only within the
  four verified store roots.

Kimi stores cwd as `md5(cwd)`. Trantor builds a reverse map only from directories that
actually exist under `~/development/` and `~/.agent-bus/worktrees/`; an unknown hash is
shown in **All** but is not falsely assigned to a project.

## Opening a row

- Claude rows switch the mode pane to the existing `Chat` transcript renderer. The
  existing `orchestrator_chat` and `chat_watch` commands accept an optional pinned
  `sessionId`, so history uses the same decoder and streaming reducer as the live
  orchestrator. A pinned historical chat is read-only: no composer, terminal tray, or
  handoff controls.
- Codex, OpenCode, and Kimi rows open the Sessions mode's compact read-only transcript.
  `session_transcript` decodes user/assistant text only; no send path exists in that view.

Synthetic fixtures live in `desktop/src-tauri/test-fixtures/sessions/`. No real user
transcript content is committed.

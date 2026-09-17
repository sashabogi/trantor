# CodeGraph blueprint — what a live code-dependency lens in the Workspace actually takes (#6879, feeds #6878)

Read on 2026-09-17 from this repo at 684e8e8 and from a shallow clone of AlgoNoRhythm/Flare (MIT).
Paths without a prefix are repo-relative; Flare paths are prefixed `flare/`. Numbers were measured
on this checkout, not estimated. Repo scale for every cost below: 634 tracked source files
(js/mjs/ts/tsx/rs), about 129k lines; graft parses 522 of them (it also takes the python under
tools/ and skips json/toml/sh).

## 1. Substrate that already exists, and what each can and cannot answer

**graft (the MCP graph, `graft/` — gitignored, built per checkout).** `graft build` extracts
every symbol and edge with tree-sitter-class parsers into `graft/.cache/extract.<repo-id>.json`
and folds them into `graft/.graph/wiring.json`: 4662 nodes (522 file nodes, 3512 functions, 261
types, 67 Rust structs) and 10921 edges. The raw extraction keeps six relations — `imports`
(2143, file to specifier, e.g. `hub/events.mjs` imports `../lib/identity.mjs`), `calls`,
`contains`, `references`, `extends`, `implements` — and wiring resolves in-repo specifiers to
file ids (`bin/adopt.mjs` → `lib/project.mjs`, relation `imports`, confidence `extracted`).
External specifiers (`react`, `monaco-editor`) are kept as text and never become nodes.
Collapsed to file granularity there are 2278 distinct file→file pairs across imports and calls,
which is the edge set a Workspace graph would draw. Measured cost: a cold `graft build` is 8.0s
wall, a warm no-op is 0.7s, `graft check` re-extracts and costs 7.4s, and `graft blast --base
HEAD~1 --depth all` (reverse closure over incoming edges from the diff's touched lines) is 0.33s.
The MCP server refreshes before every query ("refreshed the graph (263 files changed) before
answering" was observed on the first call this session). What it answers: who imports X, who
calls Y, the transitive dependents of a diff (`graft blast`, text/markdown/mermaid/json), a
file's API (`graft skeleton`), directory clusters and hubs (`graft map`). What it cannot answer:
who changed a file, when, in which seat, whether anyone read it, churn, coverage. It is one index
per directory, so a seat's uncommitted edits exist in its graph only if graft runs inside
`~/.agent-bus/worktrees/<project>/<seat>`; the main checkout's graph never sees them. Files
without a parser (package.json, tauri.conf.json) are reported as "not in the graph" by blast.

**Demerzel (foundation plugin 4.0.1, `.foundation/snapshot.txt`).** The plugin README (lines
65-75) defines it: one text file concatenating every source body under a per-file banner plus an
import/export index, and the free reads (`demerzel_find_importers`, `demerzel_get_deps`,
`demerzel_find_symbol`) are scans over that text. Trantor has no snapshot: no `.foundation/`
exists in the main checkout or in any seat worktree, so today it answers nothing here. Even
built, it is specifier-level (no path-alias or index resolution, no symbol edges, no transitive
closure) and refreshes only by regenerating the whole file; the sample snapshot for a 43-file
Swift app is 9085 lines, so a trantor snapshot would be a 130k-line text the reads grep through.
It is not a graph substrate; it is a context-loading substrate for agents. Nothing in #6878 needs it.

**The hub's event log (`state.events`).** `appendEvent` in `hub/events.mjs` L126-139 writes
`{id, ts, type, project, by, ...payload}` to one append-only stream, capped at 20000 in memory
(`RELAY_EVENT_CAP`) and persisted to the `events` table (`lib/store-contract.mjs` L47-56, indexed
by project, type, task). Card events keep the legacy `created/moved/updated` shape with `source`
and `costUsd`; everything else is dotted: `message`, `presence.online/offline`, `focus`,
`handoff.written`, `lesson`, `verify.gate.opened`, `duty-failure`, `overseer.warn`, and
`file.claim`. That last one is the only code-space signal the hub has: the PreToolUse hook
`hooks/file-claim.mjs` posts a repo-relative path to `/claim` before every edit, and
`hub/routes/admin.mjs` L270-286 logs the first touch inside a 10-minute window (`RELAY_CLAIM_TTL_MS`)
as `file.claim {file}` by that session. It is read through `GET /events` (`hub/routes/cards.mjs`
L406-425: filters by project, type prefix, actor, card, `since` cursor) or live over SSE as
`event: ev` (`hub/events.mjs` L108-113); the app's Feed already consumes it
(`desktop/src/features/feed/Feed.tsx` L76). What it answers: which seat touched which file, when,
and against which card (a claim carries the session; the session's focus card is on the board).
What it cannot answer: imports or dependents (no code knowledge at all), which commit carried a
change (the backfill posts theme-grouped titles, `bin/git-backfill.mjs` L44-70, no sha and no file
list), and whether a human opened a file (`CodeView.tsx`, `Files.tsx`, `FileTree.tsx` never post to
the hub; only `ModePane.tsx` L229 sends, and that is a message). The claim hook is a Claude Code
plugin hook (`hooks/hooks.json` L54), so codex, kimi and opencode seats post no claims; their
file activity reaches nobody until they commit.

**The git post-commit hook.** `bin/init-hooks.mjs` writes a block into `.git/hooks/post-commit`
that runs `trantor backfill --since "5 minutes ago"` in the background; the main checkout has that
block installed. It does not fire in this repo: `.git/config` sets `core.hooksPath = hooks/githooks`
(added with the pre-push gate, #6446), and git runs hooks from that directory only, which holds
`pre-push` alone. Seat worktrees share the common git dir, so the same applies to seat commits.
Even where it fires, the payload is a `source: "git"` done card titled from the commit subject,
linked to the committer's open focus card by `hub/reaper.mjs` L29-49 inside a 10-minute window.
So the record knows THAT a commit happened and roughly what it was about; it never learns the sha
or the paths, which is exactly the join a code graph needs.

**Already in the app, and worth more than the four above for #6878.** `file_watch` in
`desktop/src-tauri/src/lib.rs` L2000-2086 is a recursive `notify` 6 watcher on the main checkout
that batches paths every 200ms and emits `file-changed {project, paths}`; `FileTree.tsx` L222 and
`Files.tsx` L226 already listen. `project_changes_sync` (`lib.rs` L7829-7892) walks every seat
worktree under `~/.agent-bus/worktrees/<project>/` and returns per-seat git status plus numstat:
that is the live "what the crew is doing to files" signal, polled, and it is the one that sees
non-Claude seats. `read_file` (`lib.rs` L453) takes a `seat` parameter and reads from the seat's
worktree, so the app already knows how to address a file in a seat's tree. The watcher covers the
main checkout only; nothing watches seat worktrees today.

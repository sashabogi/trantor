# RESEARCH: how Orca does git + files + check-in/out

Card #5786 (rerouted from codex). Read-only code read of the Orca clone at
`.scratch/orca/` (Orca 1.4.178-rc.2, "Next-gen IDE for parallel agentic development",
`package.json:4`). Purpose: file:line receipts for the legacy-dev v2 wave (W4 bucket) —
operator ruling: don't reinvent, copy what works. Every receipt below was read in this
clone; paths are relative to `.scratch/orca/`.

## 0. Architecture in one paragraph

Orca is Electron with a strict two-process split: the main process owns every git and
filesystem operation; the renderer never runs git and only sees typed IPC channels
(`src/preload/index.ts:3620-3760`). All git I/O funnels through one runner
(`src/main/git/runner.ts:1-49`) into a ~30k-line `src/main/git/` module, and every
operation is reachable both locally and over SSH behind ONE interface, `IGitProvider`
(`src/main/providers/git-provider-contract.ts:22-111`). Our equivalent seam is
`desktop/src-tauri` — we already follow the same shape (commands in lib.rs, invoke from
TS), but Orca's contract surface is broader and worth copying piecemeal.

## 1. The git contract (the thing to copy first)

`IGitProvider` (`src/main/providers/git-provider-contract.ts:22-111`) groups the whole
surface: status + submodules (23-29), history (30), commit (31), staged-commit context for
AI message drafts (32), diff per file with `staged` and `compareAgainstHead` flags (33-38),
stage/unstage single + bulk (39-42), discard single + bulk (43-44), conflict detection +
abort merge/rebase (45-47), branch checkout/list/compare (48-55), upstream status + push/
pull/fast-forward/rebase/fetch (56-66), fork sync (67-70), branch/commit diff (71-79),
worktrees list/add/remove (80-91), remote file/commit URLs (105-106), and a
`worktreeIsClean` probe (107-110). Note what is ABSENT: no destructive history ops (no
reset --hard, no force-push except `forceWithLease` as an explicit option at 57-62).

**Adoption for us**: our four `git_*` commands cover stage/unstage/commit/push/status;
the v2 wave should grow toward this contract rather than ad-hoc additions — especially
`getDiff` per file, `getHistory`, bulk stage/unstage, and `worktreeIsClean`.

## 2. Status parsing — use `-z`, not lines

`parsePorcelainV1Records` (`src/main/git/porcelain-v1-records.ts:16-36`) parses
`git status --porcelain=v1 -z` by splitting on NUL, NOT on newlines. The doc comment
(8-15) is the receipt for why: without `-z`, git quotes/escapes paths containing spaces,
quotes, or non-ASCII bytes, so path comparisons silently miss; with `-z`, a rename/copy
emits its origin path as a SECOND NUL-separated field, which the parser consumes by
skipping the next field (29-32) instead of inventing a bogus record. Rows shorter than 4
bytes are skipped (24-25).

**Adoption**: our `parse_porcelain_v1` (desktop/src-tauri/src/lib.rs) splits lines and
keeps the new name of a rename. Orca's `-z` variant is strictly more correct; switch when
we touch the parser next.

## 3. Staging, commit, discard — small functions, cache discipline

- `stageFile` runs `git add -- <literal-pathspec>`; `unstageFile` runs
  `git restore --staged --` (`src/main/git/source-control/staging.ts:10-42`) — note
  unstage uses `restore --staged`, not `reset HEAD`, which is the modern spelling and
  works without a first commit.
- Bulk variants batch pathspecs to avoid E2BIG (`staging.ts:47-90`, budget logic in
  `src/main/git/source-control/bulk-pathspec-command-line-budget.test.ts`).
- `commitChanges` runs plain `git commit -m <message>` and on failure reads the error
  from stderr, then stdout, then the exception (`src/main/git/source-control/
  commit-changes.ts:15-30`) — hook/GPG failures land on stderr, "nothing to commit" on
  stdout; same dual-read we do in `write_file`.
- Every mutation wraps itself in `invalidateGitReadCaches()` before AND in `finally`
  (e.g. `staging.ts:15-23`) — one shared invalidation generation
  (`src/main/git/source-control/git-read-cache-invalidation.ts`).
- Discard is the guarded one: `isWithinWorktree` containment checks at
  `discard-changes.ts:24` and `:114` (exported at `:147`), and pathspec-based cleanup "avoids
  raw recursive deletion through symlinked parents" (`:89`).

**Adoption**: our `git_stage` unstage uses `reset -q HEAD --`; switch to
`restore --staged --`. Our mutation commands should invalidate any cached reads the panel
holds (ours re-pulls snapshots on a timer, which covers it, but explicit invalidation is
cheaper).

## 4. Check-out: worktree creation with a memory

`addWorktree` (`src/main/git/worktree-add.ts:141-227`):

- Creates with `git worktree add --no-track -b <branch> <path> [<base>]` (179-201).
  `--no-track` (with the WHY at 188) avoids inheriting the base's upstream so `git status`
  never misreports "behind by N" before the first push.
- Before creating, it resolves the effective base and can refresh/suggest the local base
  ref against its remote-tracking counterpart (`resolveWorktreeAddBaseContext`,
  `:26-59`; `worktree-base-refresh.ts`) — this is the "seats build against stale main"
  fix we carded as #5403, already solved here.
- After creating, it persists the base as `branch.<branch>.base` in local git config
  (`persistWorktreeCreationBase`, `:61-86`) — the worktree REMEMBERS what it branched
  from; stale metadata is unset, not trusted (75-84).
- It also sets `push.autoSetupRemote=true` when unset (`:88-115`, SSH parity note at
  217-222) so a plain `git push` creates and sets the upstream on first push (git >= 2.37,
  older clients ignore it) — this replaces our manual `push -u` dance.
- Bumps a worktree scan generation so caches know the world changed (`:162-164`).

Crash-safe creation locking: a worktree being prepared lives in a `.orca-preparing/<pid>-<uuid>`
directory and its git lock reason is `orca-create-preparation:v1:<pid>:<sessionId>`
(`src/shared/worktree/create-preparation.ts:1-8`); ownership is proven by parsing the PID
out of the LOCK REASON, not the path shape, so a user-chosen path can never be hidden or
force-removed by accident (`:32-42`).

**Adoption**: our worktrees are created by crew-runner and never refreshed (#5403).
Copy (a) `--no-track` + `push.autoSetupRemote`, (b) `branch.<branch>.base` persistence so
the Review lens can name the real base instead of merge-base guessing, (c) the
pid-stamped preparation lock if we ever create worktrees from the app.

## 5. Check-in: upstream, push, and the honest no-upstream state

`getUpstreamStatus` (`src/main/git/upstream.ts:50-101`):

- No upstream is a STATE, not an error: `isNoUpstreamError` is the only swallowed error
  class, normalized to `{ hasUpstream: false, ahead: 0, behind: 0 }` (68-79); everything
  else (auth, corruption, not-a-repo) surfaces. A narrow matcher on purpose — broad
  phrases like "no such branch" are deliberately NOT matched (70-73).
- A `--cherry-mark --right-only` log probe decides whether behind-commits are
  patch-equivalent (32-48) so the UI can offer rebase instead of pull-first; probe
  failure keeps the conservative behavior (43-47).
- Reads are single-flighted per execution identity through a read-owner
  (`getUpstreamStatus` → `nativeAndWslGitUpstreamStatusReadOwner.read`, 87-101).
- `git:push` accepts `publish?` and `forceWithLease?` — force only as a
  lease-checked option (`src/preload/index.ts:3667-3672`,
  `IGitProvider.pushBranch` at contract:57-62).

**Adoption**: our `aheadLabel` already treats no-upstream as a state — good. For v2:
add `forceWithLease` as the ONLY force shape, and single-flight our panel's status reads
if we ever poll faster than 12s.

## 6. Removal: trash-rename, deregistration, retirement — the safety masterpiece

`removeWorktree` (`src/main/git/worktree-removal.ts:29-173`):

- Asserts the worktree isn't git-locked before touching it (`:60`).
- FAST PATH: rename the checkout into a sibling trash dir, then clear git's registration
  for the now-missing path, then schedule the multi-GB delete in the background
  (`tryRemoveWorktreeWithDeferredDirectoryDeletion`, `:104-140`) — removal returns in
  milliseconds. If deregistration fails, the directory is RESTORED from trash so in-place
  removal still works (`:130-137`).
- Deregistration falls back to `worktree prune` + a STRICT re-list to prove the row is
  gone — "an unreadable repo must not read as proof that the row is gone" (`:166-172`).
- Branch deletion after removal is timed as its own span because it can hit the network
  (`fetch --prune`, `:92-96`), and `deleteBranch` defaults to KEEPING unmerged commits:
  `forceBranchDelete` exists only for failed-creation rollback of a fresh branch
  (`:33`).
- Submodule worktrees: git refuses non-force removal even when clean; Orca re-proves
  cleanliness then forces (`:72-82`).
- Retired names: deleted worktree names go to a retired-name registry
  (`src/shared/worktree/retired-name-registry.ts`,
  `src/main/worktree-retirement-namespace.ts`) so a recycled name can't collide with a
  still-referenced lineage.

**Adoption**: our seats live in `~/.agent-bus/worktrees/<project>/<agent>`; when we add
worktree management to the app (v2), copy this shape: never inline-delete a big tree,
keep unmerged work unless explicitly forced, and never silently reuse a seat name.

## 7. Files (non-git): one filesystem contract, watched

`IFilesystemProvider` (`src/main/providers/filesystem-provider-contract.ts:52-120`):
readDir / readFile with binary detection + size limits (54, 26-29), positional
`readFileRange` that THROWS `FileRangeReadUnsupportedError` instead of silently
degrading — the doc (41-50) warns tailing via whole-file reads is quadratic
— createFile / createDirNoClobber / renameNoClobber / deletePath / copy (91-97),
and `watch(rootPath, callback)` returning an unsubscribe (114-119).

Watching is `@parcel/watcher` in a dedicated process with shared ignore-dir lists and a
200-event batch cap (`src/main/runtime/file-watcher-host.ts:3-27`), with root-watch
ownership + teardown modules beside it. All fs mutations go through the same IPC module
as git: `src/main/ipc/filesystem.ts` (e.g. `fs:createFile`, `fs:rename` — tests at
`src/main/ipc/filesystem-mutations.test.ts:100-218` prove NoClobber and
symlink-containment refusals).

**Adoption for W4-c (live code view)**: our chat_watch/chunked reads should grow a
positional range read with the same strict-throw semantics, and the dirty-conflict bar
should be driven by an fs watch (parcel-style, ignore node_modules/.git/target) rather
than polling.

## 8. Path containment (steal verbatim)

`validateGitRelativeFilePath`
(`src/main/ipc/filesystem-path-containment.ts:57-73`): reject empty, NUL-containing, or
already-absolute paths; resolve against the worktree; refuse if not a descendant; return
the normalized relative path. Every local git/fs handler resolves the REGISTERED worktree
first (`resolveRegisteredWorktreePath`) then validates — e.g. `git:stage` at
`src/main/ipc/filesystem.ts:2232-2252`, `git:status` at `:1165`, `git:commit` at
`:1431`, `git:discard` at `:2280`, `git:bulkUnstage` at `:2361`.

**Adoption**: our guards reject `..`/absolute textually; Orca's resolve-then-isDescendant
also kills symlink escapes. Upgrade `clean_git_paths`/`seat_worktree` when we touch them.

## 9. Execution plumbing worth knowing about

- One runner entry (`src/main/git/runner.ts:14-46`): WSL routing, non-interactive env,
  prompt guards, `GIT_OPTIONAL_LOCKS=0`, untranslated-output env, streaming stdout,
  admission control (`withGitAdmission`).
- `GitAdmissionTier = 'interactive' | 'status' | 'background'`
  (`src/main/git/command-runner/git-exec-options.ts:4`) — UI-initiated ops declare
  'interactive' (see `git:stage` handler passing it at `filesystem.ts:2250`) so background
  scans can't starve clicks. Our cargo `git_run` has no tiers; a simple two-tier
  interactive/background priority is enough for v2.
- `GitCapabilityCache` + capability probe fallbacks for old git binaries (e.g.
  `SshGitWorktreeProvider.worktreeIsClean` falls back to a status-derived clean check when
  the relay lacks the method, `src/main/providers/ssh-git-worktree-provider.ts:73-110`) —
  they baseline git at 2.25 and keep fallbacks for newer flags (AGENTS.md "Git Binary
  Compatibility").

## 10. UI shape

- The renderer's git data flows through a store slice
  (`src/renderer/src/store/slices/editor/git/git-status-reconciliation.ts`), and the
  commit/review UI lives WITH the combined diff view
  (`src/renderer/src/components/editor/combined-diff/review-controls/`) — same place we
  put our git rail, independently arrived at.
- AI commit messages are a first-class channel:
  `git:generateCommitMessage` + cancel + model discovery (`src/preload/index.ts:3710-3720`;
  settings UI `CommitMessageAiPane.tsx`).
- Worktree creation is a named panel (`WorktreeCreationPanel.tsx`), and kanban work items
  drive worktree actions directly
  (`src/renderer/src/components/sidebar/use-workspace-kanban-worktree-actions.ts`) —
  the task IS a worktree, which is the same model as our worktree-per-seat.

## 11. TL;DR adoption list for legacy-dev v2

1. Switch status parsing to `--porcelain=v1 -z` with NUL records + rename-origin skip.
2. Unstage via `git restore --staged --` instead of `reset HEAD --`.
3. Persist each worktree's base as `branch.<branch>.base`; resolve real base drift
   (#5403) instead of merge-base guessing.
4. `--no-track` at creation + `push.autoSetupRemote=true` so first push just works.
5. Path guards: resolve-then-isDescendant (kills symlink escapes), reject NUL.
6. Treat no-upstream as a state object `{hasUpstream, ahead, behind}`, never an error.
7. Bulk git ops batched against E2BIG; status reads single-flighted per identity.
8. Removal = trash-rename + deregister + deferred delete; keep unmerged branches unless
   explicitly forced; retire seat names after removal.
9. Live files: fs watch (parcel-style, ignore lists, batched events) over polling;
   positional range reads that throw rather than degrade.
10. Two admission tiers (interactive/background) so panel clicks never queue behind scans.

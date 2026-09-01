# RESEARCH: Orca's renderer — the screen anatomy of review/edit, and a deletion map for our invented pieces

Card #5806. READ-ONLY, RENDERER ONLY: `src/renderer/**` of the Orca clone at
`.scratch/orca/` (Orca 1.4.178-rc.2). Companion to `RESEARCH-orca-files.md` (#5786), which
covered the main process; this doc answers: where does the changed-file list live, does an
"edit mode" exist, how do diffs open, what decorates trees, and — the point — which pieces
WE invented that Orca proves unnecessary. Paths relative to `.scratch/orca/`. Receipts
spot-checked verbatim.

## 1. The anatomy: ONE editor panel, five tab modes, one orthogonal view toggle

Every file opens as an `OpenFile` tab (`src/renderer/src/store/slices/editor/types/open-file.ts:86`):
one type, `mode: 'edit' | 'diff' | 'conflict-review' | 'markdown-preview' | 'check-details'`
(open-file.ts:147). Orthogonally, an edit-mode tab has a VIEW:
`EditorViewMode = 'edit' | 'changes'` (open-file.ts:154) — "changes renders diff-vs-HEAD in
place of the editor without a separate tab". The segmented control that unifies markdown's
source/rich/preview with edit/changes is `EditorViewToggle.tsx:18-25`, and its Changes
tooltip disambiguates from the sidebar's "Branch Changes" section
(`EditorViewToggle.tsx:59-66`).

So the screen is: a tab strip of files (some tabs ARE diffs), one `EditorPanel` per pane
(`EditorPanel.tsx:29-415`), and the panel picks a surface per mode/view. There is no
separate "review screen" and no separate "editor screen" — there are tabs.

## 2. Does "edit mode" exist? Half — and the interesting half is where it lives

The bet was "it doesn't". Verdict: there is no edit/read toggle bolted onto a review
surface like ours — but editing is everywhere, in two forms:

- **Edit mode** is a first-class tab mode (`EditorEditFileSurface.tsx`), used for plain
  "open this file and change it".
- **Changes view** is an edit tab wearing a diff: `EditorPanel.tsx:117-121` computes
  `requestedChangesMode` (edit mode + `canUseChangesModeForFile` + view=='changes'), and
  `ChangesModeView.tsx:12-16` renders HEAD-vs-working-tree "without creating a separate
  diff-tab object. The draft is the live source on the modified side; onContentChange is
  the same callback as normal edit mode so dirty tracking, autosave, and close-prompt
  plumbing all continue to work unchanged." The modified side is `editable={true}`
  (ChangesModeView.tsx:99; plumbed to monaco at `DiffViewer.tsx:420` `readOnly: !editable`).

Gate for Changes view: the file must be on-disk-relative to a worktree —
`canUseChangesModeForFile` (`editor-panel-file-mode.ts:8-14`) refuses untitled and
absolute-path-like tabs.

**Take for us**: our Files panel has three separate states (read / editing / diff) with
separate `CodeView` and read-only `DiffView` components and a segmented switch. Orca says
the diff IS an editor with the left side frozen. That is the deletion candidate in §6.1.

## 3. Where the changed-file list lives: the right sidebar's Source Control panel

Not in the editor. `src/renderer/src/components/right-sidebar/source-control/` owns it:

- `panel/` — the panel chrome: `header-toolbar.tsx`, branch context rows and stats
  (`branch-context-row.tsx`, `branch-context-stats.ts`), and `commit-surface.tsx` — the
  staging/commit UI lives HERE, not near any diff.
- `listing/` — the rows: `section-file-list.tsx`, `uncommitted-entry-row.tsx`,
  `tree-directory-rows.tsx`, `branch-section.tsx`, with per-row hover actions and
  centralized eligibility in `entry-actions.ts:13-31` (stage / unstage / discard gates,
  plus the submodule note at :5-11: a parent repo cannot stage into a submodule's tree, so
  those rows are read-only).

The editor and this panel talk through the store: the panel mutates git; the editor's
Changes view consumes `gitStatusEntries` selected per worktree
(`EditorPanel.tsx:57-62`, `editor-panel-git-entry-selector.ts`).

## 4. How diffs open: store actions, not component wiring

Clicking a changed file calls store actions that CREATE OR REVEAL a tab
(`src/renderer/src/store/slices/editor/actions/`):

- `open-unstaged-diff.ts:12-20` — `openDiff(worktreeId, filePath, relativePath, language,
  staged, options)`: builds a stable tab id from worktree+diffSource+path
  (`buildDiffEditorFileId`), sets `diffSource: 'staged' | 'unstaged'`, and if the tab
  already exists it REVEALS it and bumps a reload nonce (`withDiffContentReloadRequest`)
  instead of stacking a duplicate.
- `open-combined-diff.ts`, `open-history-diff.ts`, `open-conflict-review.ts` — the same
  pattern for the multi-file combined view, history, and conflicts.
- Preview-vs-permanent: a plain click opens a PREVIEW tab that the next click replaces;
  modifiers or `openAsPermanent` pin it (`listing/split-open.ts:26-29`:
  `return !targetGroupId && event?.openAsPermanent !== true`).
- Stability receipts: a combined tab snapshots its file list at open so a later commit
  "can't yank them out from under the combined diff (rebuild + lost scroll)"
  (open-file.ts:114-115, `uncommittedEntriesSnapshot`).

**Take for us**: diffs are tabs with identity + reload nonces, opened through one store
entry; nothing passes documents through component props the way our `DiffView base head`
does.

## 5. Tree decorations: line counts, status colors, conflict badges — and hover actions

- `listing/diff-line-counts.tsx:1-22` — the `+N −N` chip, colored from
  `var(--git-decoration-added)` / `var(--git-decoration-deleted)` so it follows the
  documented git palette.
- `listing/uncommitted-entry-row.tsx:24` imports `STATUS_COLORS, STATUS_LABELS`
  (`right-sidebar/source-control/status-display`); `conflict-badge.tsx` marks conflicts.
- Conflict rows disable dangerous actions with a stated reason: Stage is suppressed for
  unresolved conflicts "because `git add` erases the `u` record (the only live conflict
  signal) before review"; Discard is hidden for unresolved and resolved_locally
  (uncommitted-entry-row.tsx:82-83).
- The combined-diff review view has its own file tree with filter/navigation
  (`components/editor/combined-diff/browse-files/combined-diff-file-tree.tsx` +
  `combined-diff-file-tree-row.tsx`).

## 6. The DELETION map: what we invented that Orca doesn't have

Walked against our `desktop/src/features/files/*` and `features/review/*`:

6.1 **Our read/edit/diff three-state switch + read-only DiffView** — Orca has no such
switch. One tab, views are orthogonal, and the diff's modified side is the editor
(§2). We shipped a read-only Monaco DiffView (#5790); the Orca-shaped endgame is
ChangesModeView: delete the separate "editing" state, make the diff editable on the
modified side, and read mode becomes "diff with no changes" (their identical-content
banner, ChangesModeView.tsx:64-86, is exactly our "Clean" ghost).

6.2 **Our save-commits-as-you (#5440)** — Orca's save is a plain file write plus an error
toast (`editor-file-save-attempt.ts:6-19` → `requestEditorFileSave`); NO commit anywhere
in the save path. Dirty work lives in the SCM panel until an explicit stage/commit
(`panel/commit-surface.tsx`). Our auto-commit exists for attribution (integrate commits
dirty worktrees as-seat); now that the Review lens has a git rail (#5775), the
commit-on-save behavior is a candidate to REPLACE with save-then-stage-hint. At minimum
it should stop being invisible.

6.3 **Our Review-lens git rail (#5775)** — Orca never puts stage/commit/push inside the
diff view; it lives in the always-present SCM sidebar (§3). The rail's JOB is right (our
Review lens has no sidebar); its POSITION is the invention. If Trantor grows a right
sidebar, the rail's contents move there and the rail dies.

6.4 **Our per-file truncated chip** — validated, not deleted: Orca caps large diffs too
(`largeDiffRenderLimit`, ChangesModeView.tsx:67; `too-many-changes-banner.tsx` in
listing/).

6.5 **Our comment-to-seat composer** — validated: Orca has `DiffNotesSendMenu.tsx` and
`combined-diff/review-controls/combined-diff-notes-popover.tsx` — notes anchored to a diff
that ride to the agent. Two teams, same answer; ours is cruder (whole-file note) but the
concept is confirmed.

6.6 **Our ancestor-marking FileTree decorations** (lib.rs `git_status_map` marking every
ancestor folder) — I found no renderer counterpart in scope; Orca decorates ROWS (counts,
colors, badges), not ancestor folding. Unverified beyond this read; not a deletion, a
difference to re-examine when we touch the tree.

6.7 **What we LACK and should steal**: preview tabs (§4), tab-level
`lastKnownDiskSignature` + `externalMutation: 'deleted' | 'renamed' | 'changed'`
(open-file.ts:124-126) — a persisted, per-tab version of our liveReload conflict bar that
gates autosave until the disk baseline is re-verified (open-file.ts:128); stable
snapshots for open diff tabs (§4); and the conflict-row action suppressions (§5).

## 7. TL;DR

The changed-file list is a right-sidebar Source Control panel, not part of any editor
surface. Edit mode exists as a tab mode whose "Changes" view is a live editable diff
against HEAD — the editor and the diff are the same surface. Diffs open as identity-keyed
tabs through store actions with preview/permanent semantics. Tree rows carry line counts,
status colors, and conflict badges with reasoned action suppression. Deletion map: our
read/edit/diff switch (§6.1) and commit-on-save (§6.2) are inventions Orca disproves; the
git rail's position (§6.3) is an invention of layout, not concept; comment-to-seat and
diff caps are independently confirmed (§6.4-6.5).

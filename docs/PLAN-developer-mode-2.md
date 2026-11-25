# Developer mode, second wave: the holes found next to Ember (overnight, 2026-11-25)

Operator ruling 2026-11-25 about 01:35, after the gap check (card #14093): "card everything in the
before Mixed list and build it ... build through tonight. I'd like to see it done when I wake up in
the morning." This file is the work order. The first wave is `docs/PLAN-developer-mode.md` (done).

Sources: `docs/research/ember.md` (the Ember study), and the two gap tables on the seat branches,
not merged: `git fetch netcup seat/kimi-9 && git show FETCH_HEAD:docs/research/gap-kimi-9.md`
(dbece6be) and the same for `seat/glm-5` `docs/research/gap-glm-5.md` (045f0e17). Read the rows
for a slice before writing its contract. Never copy Ember's code or assets.

## Rulings that shape this wave

- **The developer's own checkout gets a full git loop in Developer mode.** Today push and discard are
  refused there (`CHECKOUT_REFUSAL` in `v2/screens/Code/scopeGitApi.ts`, "go through the
  orchestrator") and a test asserts it. The operator's ruling above reverses that for Developer mode
  only. Orchestrator mode keeps the refusal. Add one flag to `MODE_CONFIG` in
  `v2/shell/shellMode.ts` and read it; change the test to assert both sides.
- **Safety that does not move:** never a plain force push (not in this wave at all); discard always
  copies the work to the Trash first; deleting a branch refuses the checked-out branch and `main`;
  a git change on a seat's worktree while the seat is working stays refused
  (`git_mutation_guard`); nothing is staged, committed or pushed without a click.
- **No control ships that does nothing.** About a dozen buttons in `v2/screens/Code` are drawn
  disabled with a "not wired" reason. Each is either wired by a slice below or removed. The ones
  that belong to Mixed mode (crew review, pull request Merge and Open on GitHub, Split editor) are
  removed now and come back with their feature.
- **Not in this wave:** pull requests, keep or undo per change, the approval card, agent review,
  who wrote this line, split editor, extensions, run and debug. The language server spike (#13985)
  has no ruling yet: do not start it.

## Slices

One card each, one owner, a drill on the built app. Card notes point here for the detail.

| # | Card | What | Main files |
|---|---|---|---|
| G1 | #14099 | Sync and safety on the checkout: pull (fast-forward; when diverged say so and offer merge or rebase), push from the own checkout in Developer mode, discard a file or everything to the Trash, stash (save with a message, list, apply, pop, drop) | `src-tauri/src/git_scope.rs` (+ a new module if it passes 1,000 lines), `Code/Toolbar.tsx` (a sync menu), `Code/ChangesList.tsx`, `ui/ScmSidebar/`, `scopeGitApi.ts`, `shell/shellMode.ts` |
| G2 | #14100 | Branches: list local and remote, create (also from a commit), switch with a choice for uncommitted files (bring them or stash them), rename, delete, merge into the current branch, rebase onto | `Code/BranchPicker.tsx`, `Code/CommitDetail.tsx`, native branch commands |
| G3 | #14101 | Commit depth: amend, undo the last commit when it is not pushed, commit and push; stage, unstage and discard one hunk or selected lines (`git apply --cached` with a patch built from the diff) | `Code/ChangesList.tsx`, `Code/DiffView.tsx`, `Code/diff.ts`, native |
| G4 | #14102 | History depth: all branches, search by `file:` and `message:`, commit detail with parent, full message and stats, Open on GitHub from the remote URL, file history and line history (blame), merge or rebase in progress banner with Continue and Abort | `Code/HistoryView.tsx`, `Code/CommitDetail.tsx`, `Code/DiffView.tsx`, `Code/ConflictView.tsx`, `git_panel.rs` |
| N1 | #14103 | Go to file (Cmd+P) from anywhere in a project, a command palette (Cmd+Shift+P) over one command registry, and a Keyboard page in Settings that lists every shortcut from that registry | new `v2/shell/commands.ts`, new `v2/ui/QuickOpen/`, `ShellV2.tsx`, `screens/Settings/` |
| S1 | #14104 | Search options: regular expression, whole word, files to include and exclude, and replace (one result, one file, all) with a count shown before it runs | `Code/SearchPane.tsx`, `Code/textSearch.ts`, `src-tauri/src/text_search.rs` |
| E1 | #14105 | Editor footer (line and column, selection size, language, indentation, problems from the last check) and change markers beside the lines (added, changed, removed against HEAD, updated on edit and save) | `Code/FileEditor.tsx`, new `Code/EditorFooter.tsx`, new `Code/useChangeMarkers.ts` (through the `onReady` editor; `features/code/CodeView.tsx` stays as is) |
| F1 | #14106 | Files: move, copy path, copy relative path, reveal in Finder, rename and delete a folder; previews for Markdown (rendered, with a Source switch) and images | `ui/ExplorerTree.tsx`, `ui/ExplorerRow.tsx`, `src-tauri/src/file_ops.rs`, `Code/FileEditor.tsx`, new `Code/FilePreview.tsx` |
| X1 | #14107 | The desktop question card shows every question an agent asked, not only the first (the phone already does) | `features/chat/Chat.tsx` AskCard, `src-tauri/src/asks.rs` answer path |
| X2 | #14108 | Notifications only when Trantor is in the background, with a setting for it, on by default | `shared/notify.ts`, `screens/Settings/` Notifications page |
| G5 | #14109 | Audit, last: every control still drawn disabled with "not wired" in `desktop/src/v2` is wired or removed | orchestrator, after G1 to G4 are on main |

## Owners and order

- **kimi-9:** G1, then G2, then G3, then G4, one after the other. They share the native git files and
  the Code git screens, so they must not run in parallel. Send the next contract only after the
  previous one is on main.
- **glm-5:** S1, then F1, then X2. Never name a path outside its worktree in a card or a message.
- **Claude sub-agents** (`isolation: 'worktree'`, `model: 'sonnet'`, told to
  `pnpm install --frozen-lockfile` in `desktop/`, to share the cargo cache with
  `CARGO_TARGET_DIR=<main checkout>/desktop/src-tauri/target`, and to write no example or doc
  files): N1, E1, X1, in parallel. Check the Claude budget first; if it is thin, queue these behind
  the seats instead.
- **codex-8 is out** (Codex quota until Dec 20). Never route a card to the `claude` seat.
- **Orchestrator:** review every diff line by line, merge with `git cherry-pick -n`, gate, commit,
  push; G5; builds; drills; the morning report.

Hot files that several slices touch: `Code/index.tsx`, `Code/FileEditor.tsx`, `Code/Toolbar.tsx`,
`src-tauri/src/app.rs` (the command list). Tell every executor to keep edits there small and
additive. Expect to resolve those merges by hand.

## Gates

- `desktop/src/v2` only: `cd desktop && npx tsc --noEmit`, whole `npx vitest run`,
  `node bin/slop-gate.mjs` from the root.
- `desktop/src-tauri`: also `cargo test`.
- `desktop/src/features`, `desktop/src/shared`, `bin/`, `lib/`, `hub/`, `hooks/`: the WHOLE root
  suite (`npm test`, about 10 minutes, in the background) BEFORE the push. X1 and X2 need it.
- A bounce says "stay on seat HEAD <sha>, new commit on top, do not rebase".
- Git commands in tests run against temp repos, never this checkout. No test may push anywhere.

## Build, install and drill

`cd desktop && pnpm tauri build` after each batch of merges. Install without touching the running
app: move `/Applications/Trantor 2.0 Preview.app` to `.prev.app` (the open app keeps working; the
older `.prev` goes to the Trash), then `ditto` the new bundle to the normal name.

Drills need the screen unlocked and the pointer free. Overnight: if the Mac has been idle 20
minutes and `CGSSessionScreenIsLocked` is false, quit the Preview, relaunch it with a clean
environment (`env -i HOME=$HOME USER=$USER SHELL=$SHELL PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin open "/Applications/Trantor 2.0 Preview.app"`)
and drill. If it is locked, install the build, leave the drills owed and say so in the morning
report. Tool notes are in the `trantor-gotchas` memory ("Drill tool traps found 2026-11-25").

**Git drills never touch this repository's real history.** Make a scratch repo for them (a bare
"remote" and a clone under the scratchpad, registered as a project with `trantor hub set`, or use
the `Ember` scratch project if it is one) and push, pull, discard, branch and stash there. Remove
the scratch project when done.

A card moves to done only with its drill written on it. What was not seen stays in testing with the
unseen part named.

## Morning report

What is on main, which build is installed and whether it is the one running, each card with done
or testing and what is owed, every bug the drills found, and anything decided on the way that the
operator should confirm.

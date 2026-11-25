# Developer mode build plan (overnight wave, 2026-11-24 to 25)

Operator ruling 2026-11-24 23:20: build Developer mode first, Mixed second. Build it overnight with
the crew and Claude sub-agents in parallel, without asking; they want to see it done in the morning.
Claude quota until the weekly reset (about 18 hours from the ruling): 20% of the plan, 23% of Fable.

Design: canvas https://claude.ai/artifact/JCKFtKfjYYfpUzprn11Vgr, artboard "2 · Developer mode · code,
git, review" (`project/Developer.dc.html`; read it with the Artifact tool, it is not mirrored in the
repo). Trust ladder: artboard 4. Reference product for shape only: Ember (VS Code base). Never copy
its code or assets; build on Monaco and what we have (doctrine rule 5).

## What exists already

- The mode switch in the top bar (`desktop/src/v2/shell/TopBar.tsx`) saves the choice and nothing
  reads it (`ShellV2.tsx`, `mode` state). It is a dead control today.
- Code screen (`desktop/src/v2/screens/Code/`): Monaco file tabs, diff, history, source control
  sidebar (`ui/ScmSidebar/`), Fetch, file tree with git letters, filename search, chat rail.
- Terminal pane (classic component, mounted by the Workspace) attached to herdr panes.
- Chat with composer, mode chip, model and effort menus.

## What Developer mode is (v1)

Selecting Developer changes the shell for the project on screen:

1. A project opens on Code, not Workspace. The project lens tabs put Code first.
2. Layout, VS Code shape: activity bar and sidebar on the left (Explorer, Search, Source control,
   Agents, Cards), editor tabs in the middle, a bottom panel, the chat as a right rail.
3. The main rail (Dashboard, Inbox, ...) stays, collapsed to icons by default in this mode.
4. Agents are tools: the developer calls one on a file or a selection and reviews what it did.

Mixed is not built in this wave. Its button stays visible, is not selectable, and says why in its
title ("Mixed mode comes next: it needs keep or undo per change and approval rules on the hub").

## Slices

Each slice is one card with one owner, a drill on the built app, and its own files. Cut the cards
from this list (card notes are capped at 2,000 characters, drills at 300).

| # | Slice | Files | Owner |
|---|---|---|---|
| D0 | Mode plumbing: one `useShellMode` source; per-mode config (landing lens, lens order, rail default); Mixed not selectable; Orchestrator unchanged | `v2/ShellV2.tsx`, `v2/shell/TopBar.tsx`, `v2/shell/ProjectFrame.tsx`, `v2/routes.ts`, new `v2/shell/shellMode.ts` | orchestrator inline or one Claude agent, FIRST: everything imports it |
| D1 | Bottom panel: tabs Terminal and Output, resizable, toggle with Ctrl+backtick, maximise, close; state remembered | new `v2/ui/BottomPanel/`, mounted by Code screen | crew seat |
| D2 | Terminals: a project shell (not a seat) in the panel, several at once with a list on the right, new and kill; reuse the classic terminal pane and herdr panes; a native command only if herdr cannot open a plain shell pane in the project folder | `v2/ui/BottomPanel/Terminals.tsx`, maybe `src-tauri/src/` | Claude agent (needs Rust judgment) |
| D3 | Output tab: channels with real data: app trace (`~/.agent-bus/app-trace.log` tail through a native command), and one per live seat (its runner output, where readable) | `v2/ui/BottomPanel/Output.tsx`, `src-tauri/src/` | crew seat |
| D4 | Text search: native `search_text` (ripgrep, respects .gitignore, capped) and a Search view with results grouped by file, match counts, click opens the file at the line | `src-tauri/src/`, `v2/screens/Code/Sidebar.tsx` SearchPane | Claude agent |
| D5 | Editing: confirm what `FileEditor.tsx` can do today; make edit and save work (Cmd+S, dirty dot on the tab, refuses on a remote seat with the reason), git letters update after save | `v2/screens/Code/FileEditor.tsx`, `useTabs.ts`, file write command | crew seat |
| D6 | Agents as tools: from a selection or a file, "Ask about this" and "Send to <seat>" put `path:line` context into the composer; uses the existing Add to chat path | `v2/screens/Code/`, `ChatRail.tsx` | crew seat |
| D7 | Prompt timeline in the chat (see below) | `v2/screens/Workspace/` chat column, classic chat read-only import | Claude agent |
| D8 | Problems tab: only if a real source exists (a `tsc --noEmit` or `cargo check` run on demand, parsed). If not, do not add the tab | `v2/ui/BottomPanel/` | last, optional |

Debug Console and Ports are not built: nothing to show.

### D7, the prompt timeline (from Ember, investigated 2026-11-24)

Ember calls it a prompt timeline (`promptTicks`, `activePromptId`, `prompt-timeline-card` in its
bundle). Each tick is one USER PROMPT in the chat, in order. Hover shows a card: the prompt text, the
time, the files changed as a result, and a button to open that diff. The highlighted tick is the
prompt on screen. What sets a tick's length was not confirmed; treat it as the size of the change.

Ours: a thin column of ticks beside the chat scroll area, one per operator message. Hover card:
prompt (two lines), when (shared/time `when()`), and what that prompt produced where we know it
(commits and files from the turn's card, or the hub's turn rows, `GET /telemetry/turns`). Click
scrolls to the message. The tick for the message on screen is highlighted. No tick length encoding
unless real data backs it: equal ticks are fine.

## Order and parallelism

D0 first, merged and pushed before anything else is dispatched (a new card contract realigns a seat
to origin/main). Then D1, D4, D5, D6, D7 in parallel; D2 and D3 after D1 is on main (they mount in
it). D8 last.

Executors: crew seats kimi-9, glm-5 and codex-8 (all three reported ready on 0.18.134 at 23:18),
plus Claude sub-agents with `isolation: 'worktree'`, `model: 'sonnet'` for implementation. Tell
worktree agents to `pnpm install --frozen-lockfile` in `desktop/`. Never route a card to the
`claude` seat.

## Gates (learned the hard way on 2026-11-24)

- Any change under `desktop/src/v2`: `cd desktop && npx tsc --noEmit`, whole `npx vitest run`,
  `node bin/slop-gate.mjs`.
- Any change under `desktop/src-tauri`: also `cargo test`.
- Any change under `bin/`, `lib/`, `hub/`, `hooks/`, or `desktop/src/features|shared`: the WHOLE
  root suite (`npm test`, about 10 minutes, run it in the background) BEFORE the push.
- Read every seat diff line by line. Seats report focused suites.
- A bounce says "stay on seat HEAD <sha>, new commit on top, do not rebase".
- glm (opencode): never name a path outside its worktree in a card.
- Nothing that reverses a written or tested decision merges without the operator's answer.
- No control ships that does nothing. Wire it or leave it out.

## Preview build and drill

Build with `cd desktop && pnpm tauri build` after each batch of merges. Overnight the Mac may be
locked: do NOT swap or launch the app then (check `CGSSessionScreenIsLocked`). Stage the bundle as
`/Applications/Trantor 2.0 Preview.new.app` and swap when the operator is back. Drill by screen
capture and clicks through a Terminal `.command` file that closes its own window (recipe in the
`trantor-gotchas` memory); say so before taking the pointer.

Morning drill, Developer mode: click Developer: the project opens on Code with the sidebar, editor
tabs, bottom panel and chat rail. Open a file, edit, save: the tab's dot clears and the file shows
`M` in Changes. Search text: results grouped by file, a click opens the line. Toggle the bottom
panel, open two terminals, run `git status` in one. Output shows the app trace. Select code, "Ask
about this": the composer holds the path and lines. Hover a tick in the chat: the card shows the
prompt and what it changed; a click jumps there. Click Orchestrator: everything is as it was.

# Trantor 2.0 build plan (overnight wave, 2026-11-24)

The spec is the artboards in `docs/design/v2/*.dc.html` (published canvas:
https://claude.ai/artifact/JCKFtKfjYYfpUzprn11Vgr). Each file is plain HTML with inline styles: read it, match
its layout, copy and states. Numbers in the artboards are placeholders; wire real data where the hub has it.

## Shape

- 2.0 is a **new shell** in `desktop/src/v2/`, behind a toggle. The classic app (`src/app/AppShell.tsx`,
  `src/features/*`) is not edited except for the one toggle line. Nobody loses the working app overnight.
- Toggle: `localStorage["trantor.ui"] === "v2"` (or `?ui=v2`). `main.tsx` renders `ShellV2` when set; classic
  Settings › General gets a "Try Trantor 2.0" button; 2.0 has "Back to classic" in its account menu.
- 2.0 reuses the classic data layer as is: `HubClient` (`src/shared/api/client.ts`), presence, tasks, time
  helpers, Tauri commands. It may reuse classic heavy components (terminal pane, Monaco editor, file tree, git
  panel internals) by import, wrapped in 2.0 chrome. It never forks them.
- Where the hub has no data for something an artboard shows, the screen renders an honest empty or
  "not wired yet" state with the label from the artboard, never invented numbers.

## Layout of `desktop/src/v2/`

```
v2/ShellV2.tsx            top bar, mode switch, left rail, project switcher, bottom bar, routing
v2/theme.css              tokens from the artboards (Graphite): bg #0E0F12, panel #121317/#16181C,
                          edge #22252B, text #E7E9EC/#C4C8CE/#9AA0A8, accent #8AA8FF, ok #7CC49A,
                          warn #F2B544, bad #E58A8A; Inter + JetBrains Mono
v2/ui/                    primitives: Avatar (seat monogram + presence dot), ProjectTile, Chip, Button,
                          IconButton (aria-label + hover title, always), Ring (context %), Seg (segmented),
                          Section, Kbd, Composer2 (agent chip, model, effort bars, permission shield,
                          context ring, paperclip beside round send)
v2/screens/<Name>/        one folder per screen; each exports one component; tests beside it
```

Rules (BUILD-DOCTRINE): files at most 800 lines, functions at most 80; one-line why-comments that cite the
card; no `any`; no new dependencies without a card (monaco-vscode-api is the spike's call, not a screen's);
icons are lucide-react (already a dependency) or inline SVG; every icon-only button has `aria-label` and a
hover `title` that says what it does.

## Cards (one per screen; owner in brackets)

| # | Screen | Artboard | Data it wires | Owner |
|---|---|---|---|---|
| F | Foundations: ShellV2, theme, ui/ primitives, toggle, routing stubs for every screen | all | peers, balances, machinesHealth (bottom bar) | Claude agent (foundations) |
| 1 | Dashboard + Working grid | Dashboard, WorkingGrid | tasks, peers, holds, proposals, inbox, machinesHealth, economics | Claude agent |
| 2 | Workspace | Workspace | peers, tasks, card, terminal pane (classic import), handoffs | Claude agent |
| 3 | Code and Git: history, commit detail, full-width diff, branch picker, PR, conflict | CodeGit, BranchPicker, PullRequest, MergeConflict | classic git Tauri commands + Monaco diff; PR/checks via `gh` only where a command exists, else empty state | Claude agent |
| 4 | Board + card drawer | Board | tasks, card, moveCard, checklistToggle, peers | codex-8 |
| 5 | Inbox | Inbox | inbox, send, proposals, decideProposal, holds, decideHold, staleness (classic) | kimi-9 |
| 6 | Usage and costs | Usage | balances, economics, events | Claude agent |
| 7 | Agents + Overseer column | Agents | peers, balances, machinesHealth, overseerStatus, policy, setAutonomy, proposals | Claude agent |
| 8 | Extensions and tools | Extensions | Open VSX search API (read-only fetch) + installed MCP list where readable; install buttons are disabled with "after the extension-host spike" | Claude agent |
| 9 | Settings (Autonomy page in full, other sections as real classic content re-skinned) | Settings | policy, setAutonomy, pairInvite, classic Accounts/Agents panes | glm-5 (light) or Claude agent |
| S | Spike: can monaco-vscode-api run a Node extension (rust-analyzer) inside our Tauri app? | Extensions | none | after the screens |

## Gate for every card (the orchestrator runs it, not the author)

1. `cd desktop && npx tsc --noEmit` exit 0
2. `cd desktop && npx vitest run src/v2` green, plus the whole desktop suite before merge
3. `node bin/slop-gate.mjs` clean
4. Classic untouched: `git diff --stat main -- desktop/src/app desktop/src/features` shows only the toggle line
5. Drill (orchestrator, on the built app): open the screen with the toggle on, compare with its artboard,
   click every control that has data behind it

Seats never launch the app, log in anywhere, or run trantor up/down (doctrine 12). Each card ends with one
commit on the executor's branch; the orchestrator merges to main.

## Order

F first (everything imports it). Then 1 to 9 in parallel. Then integration: one pass for consistent rail,
bottom bar and composer across screens, then `pnpm tauri build`, install, drill each screen, release.

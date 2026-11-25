# Trantor 2.0 wiring wave: what is still not wired or wrong (operator walk-through, 2026-11-24 evening)

Source: the operator's screenshots after creating a real project (rock-os) with the new Start a project flow
(CleanShot 7.05 to 7.10 PM, `~/Library/Application Support/CleanShot/media/`). Their words: "A bunch of stuff is
still not wired."

## A. Mode chip said "Mode unknown" on a fresh pane and blamed the version: CONFIRMED TIMING
A few minutes later the same chip read "Bypass" on Claude Code 2.1.331 with no change to the app (operator
screenshot 7.14 PM). So the 2.1.331 footer parses fine; the first read happened while Claude was still booting and
nothing re-read. `desktop/src/v2/screens/Workspace/useAgentMode.ts` reads on mount, after a send, when working
flips to idle, and on window focus.
Fix: retry while unknown (short interval, bounded) and re-read when the chip menu opens; say "reading…" during
boot; blame the version only after a read of a settled pane fails. Then raise `verified_up_to` to 2.1.331 at the
next release.
Operator context: their Claude Code starts EVERY session in bypass permissions (a global setting they chose long
ago and prefer). Other developers will not have that. Nothing may assume a starting mode: always show what was
read. Two places assume today and are wrong for this operator:
- the post-create hint "Opened in Agent mode. Switch to Plan from the composer's first chip." (the session was in
  Bypass): print the mode that was read, or say nothing until it is read;
- the inspector chip "Asks first" beside a pane in bypass: it shows the autonomy dial, not the session. Show the
  session's read mode there, and label the dial as what it is (applies to new sessions and handoffs).

## B. New project wake: IT LANDED, the status line did not say so
rock-os received "You were just woken via Trantor. Catch up…" and answered with a correct recap of an empty
project (screenshot 7.14 PM). But the Workspace line never advanced to "First prompt delivered", and for a while
the chat said "kickoff pending, waiting for idle" with Claude idle. Check `useWakeStatus.ts` against the real
wake-progress events (phases opened, waiting_idle, kickoff_sent, kickoff_landed, ended): the final phases are not
reaching the line, or it is dismissed early. The wake itself took minutes; time it and see whether herdr's idle
detection for a fresh pane is the slow step (`desktop/src-tauri/src/genesis.rs` wake ladder).

## C. Dashboard
- "By project" and "By agent" are not wired.
- Headline still "72 things need you"; "235 cards have sat in testing over a week". The queue needs scoping and
  ranking; frozen projects should be out.
- "0 agents are moving" while seats are working.
- Working-now rows and "Your move" rows print raw session ids ("MacBook-Pro-M1:crebral-cortex",
  "codex-8:trantor"). Use `seatLabel`.
- The project sidebar lists all 89 folders under ~/development. Show projects with activity; put the rest behind
  "show all".

## D. Agents
"Add seat" and "Start seat" disabled ("Seats start from the trantor CLI for now"), Ask the Advisor disabled,
per-seat swap / hand off / restart / stop disabled, History and Trust rules tabs not wired.

## E. The left column must be a SOURCE CONTROL SIDEBAR, not only a file tree (operator, clarified 7.18 PM)
"I still don't see any of the stuff that we agreed on in the previous round." Reference: the operator's Ember
screenshot (`CleanShot 2026-11-24 at 7.18.16 PM.jpg`): the left column is "Source Control" with collapsible
sections: **Changes** (commit message box, Commit split button, then EVERY changed file in one flat list with its
letter, so nobody hunts through subfolders; count badge; stage / discard / open on each row), **Graph**,
**Forge**, **Recent Commits**, **Agent Review**. The operator's point: anything touched sits on top, immediately
visible and one click away.
We designed our own version of exactly this on 11-23: the source control sidebar in
`docs/design/v2/BranchPicker.dc.html` (branch pill, commit box naming its target, Staged, Your changes, the
seat's work boxed separately with Keep all / Undo all / Open PR, Branches and seats, Pull requests, Crew review,
Stashes). It was folded away on the Code artboard to give the diff room, and never built as a column.
Build: in the Workspace left column and in Code's sidebar, sections in this order: Changes (flat list of changed
files with letters and counts, commit box, stage/unstage; uses `scopePanel`/`scopeStage`/`scopeCommit` from
`desktop/src/v2/screens/Code/scopeGitApi.ts`; main-checkout rules apply), Files (the tree), Recent commits
(`git_panel` log; a click opens the commit in Code), Branches and seats, Crew review. Each section collapsible
and remembered. Graph and pull requests where data exists, otherwise leave them out rather than show a stub.

## F. Open from earlier, still not wired
Workspace Reasoning / Preview / Tests tabs; Browser lens; Board Dependencies / By seat / New card / Has a PR; Usage
heatmap and wasted-turn causes; Extensions installs (#13985); Settings sections (Models, Keyboard, Memory and
rules, Hooks, Budgets, Repository, Worktrees, Editor, Storage); Inbox ranking by what an answer unblocks; Code:
Fetch, Discard, Stage hunk, branch create/switch, PR data; Ask mode; #14018 Codex commands; bottom bar "Kimi usage
unread".

## How to run it
Do not patch one by one. Group by what is missing (a hub endpoint, a native command, or only UI), decide per item:
wire it, remove it, or keep it stated. Run it as a wave with the crew, each card with a drill on the built app.

# Trantor 2.0 wiring wave: what is still not wired or wrong (operator walk-through, 2026-11-24 evening)

Source: the operator's screenshots after creating a real project (rock-os) with the new Start a project flow
(CleanShot 7.05 to 7.10 PM, `~/Library/Application Support/CleanShot/media/`). Their words: "A bunch of stuff is
still not wired."

## A. Mode chip says "Mode unknown" on a fresh pane and blames the version
The new project's pane footer plainly shows `bypass permissions on (shift+tab to cycle) · ← 1 agent`, yet the chip
reads "Mode unknown" with "Claude Code 2.1.331 is newer than the version mode switching was checked on (2.1.326),
and its mode line could not be read."
Likely cause, to confirm: `desktop/src/v2/screens/Workspace/useAgentMode.ts` reads on mount, after a send, when
working flips to idle, and on window focus. At mount Claude was still booting, and nothing re-reads.
Fix: retry while unknown (short interval, bounded) and re-read when the chip menu opens; blame the version only
after a read of a settled pane fails. Then check the 2.1.331 footer strings against
`desktop/src-tauri/src/fixtures/pane-mode/` and raise `verified_up_to` at the next release.
Quick check for the operator: click another window and back; if the chip then reads "Bypass", it was timing.

## B. New project wake
The status line stayed at "Orchestrator is open. Waiting for it to take its first prompt…" and the chat showed
"kickoff pending, waiting for idle" while Claude sat idle at its prompt. Confirm whether the kickoff ever landed.
Suspect: herdr's idle detection for a fresh pane (`desktop/src-tauri/src/genesis.rs` wake ladder), the same
dependency the plan-first idea has. Also: the inspector chip said "Asks first" while the pane was in bypass; that
chip shows the autonomy dial, not the session.

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

## E. Files and git
The operator still does not see the git surface they expect beside the files (their message was cut off: "I still
don't see any of the git stuff that we…"). The tree now shows letters and folder dots, but trantor's main checkout
has almost no changes, so little shows. Probably wanted: a Source control section in the left column like the
reference (changes list with letters, commit box, branch, recent commits), not only decorations. ASK before
building.

## F. Open from earlier, still not wired
Workspace Reasoning / Preview / Tests tabs; Browser lens; Board Dependencies / By seat / New card / Has a PR; Usage
heatmap and wasted-turn causes; Extensions installs (#13985); Settings sections (Models, Keyboard, Memory and
rules, Hooks, Budgets, Repository, Worktrees, Editor, Storage); Inbox ranking by what an answer unblocks; Code:
Fetch, Discard, Stage hunk, branch create/switch, PR data; Ask mode; #14018 Codex commands; bottom bar "Kimi usage
unread".

## How to run it
Do not patch one by one. Group by what is missing (a hub endpoint, a native command, or only UI), decide per item:
wire it, remove it, or keep it stated. Run it as a wave with the crew, each card with a drill on the built app.

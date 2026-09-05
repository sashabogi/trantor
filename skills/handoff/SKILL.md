---
name: handoff
description: |
  Finish the CURRENT session in one move: write a rich model-authored handoff, open a fresh
  full-window session that takes over (it auto-recaps the handoff), and close this one once the
  fresh session has it — a clean baton pass, one session at a time. Use when you want to wrap up
  and continue fresh on demand (not just at the compaction threshold). Trigger: /trantor:handoff
user-invocable: true
---

# Relay Handoff — pass the baton to a fresh session

Write a complete handoff capturing everything a NEW session needs to continue this work without
re-deriving context, and save it so the next session in this project auto-loads it on start.

The dispatch rule that guards the crew skills applies to a baton too: the target project is
confirmed from the session's badge and cwd before any dispatch (`relay_send`, `relay_task_add`,
`trantor up`) — a baton belongs to THIS project, never to a project an ambiguous instruction names.
And a session that is asking the operator a question never triggers a wake: if the operator has an
open question from you, resolve it or record it in the handoff before passing the baton.

Hosted in a Workspace pane? Since 0.18.18 `--baton` detects the pane and drives the in-place
replacement itself (idle gate, graceful end, reopen, kickoff prompt) — no Terminal window opens,
and the successor recaps unprompted. Nothing extra to do; the notes below about windows apply
only to plain Terminal sessions.

## Instructions

PREFER THE GLOBAL `trantor` BINARY when it is on PATH (`command -v trantor`): it runs the
INSTALLED version's code, while `${CLAUDE_PLUGIN_ROOT}` is the plugin-cache copy pinned when this
session booted — a session opened before an update runs stale logic (witnessed 2026-09-02: a
0.18.20 cache copy mis-resolved the project from a subfolder cwd and closed a Terminal window that
was not its own). Use `trantor handoff …` for both commands below; fall back to the
`node "${CLAUDE_PLUGIN_ROOT}/bin/write-handoff.mjs" …` form only when `trantor` is absent.
`trantor handoff` takes piped markdown (a heredoc) and `--latest` exactly like the helper, because
it forwards to the same package's `write-handoff.mjs`.

0. **Already written one this session?** Then do NOT write it again — pass the baton on it:
   ```bash
   trantor handoff --latest
   # or, without the global binary:
   node "${CLAUDE_PLUGIN_ROOT}/bin/write-handoff.mjs" --baton --latest
   ```
   That picks this project's newest unconsumed handoff and hands it over untouched, and exits
   non-zero if there isn't one. Recomposing a handoff you already wrote costs minutes and produces
   a second, slightly different document.

1. Otherwise, compose a thorough markdown handoff for the current task with these sections (be specific —
   exact file paths, concrete next actions; the successor has a fresh window and only this):
   - **TASK** — what we're doing and the goal
   - **STATE** — what's done, what's in progress
   - **KEY DECISIONS** — choices made and why
   - **OPEN THREADS & NEXT STEPS** — the concrete actions to do next, in order
   - **KEY FILES & LOCATIONS** — exact paths, commands, URLs, IDs the successor needs
   - **GOTCHAS** — anything that will bite if forgotten

2. Save it AND pass the baton in one shot — pipe the markdown to the helper with `--baton`:
   ```bash
   trantor handoff --baton << 'HANDOFF'
   <your handoff markdown>
   HANDOFF
   ```
   (or `cat << 'HANDOFF' | node "${CLAUDE_PLUGIN_ROOT}/bin/write-handoff.mjs" --baton` without the
   global binary.)
   `--baton` writes the handoff, opens a FRESH session that takes over (it auto-recaps the handoff
   on open), and closes THIS Terminal window once the fresh session has consumed it — a true baton
   pass, one session at a time. (Omit `--baton` to only write the handoff without spawning/closing.)
   It's safe: the original window is closed ONLY after the fresh session confirms it took over, and
   never if the fresh session fails to start.

3. Tell the user briefly: "Handoff written — a fresh session is opening and will recap it; this
   window closes once it takes over." Then stop (the baton will close this session shortly).

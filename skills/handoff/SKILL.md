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

## Instructions

1. Compose a thorough markdown handoff for the current task with these sections (be specific —
   exact file paths, concrete next actions; the successor has a fresh window and only this):
   - **TASK** — what we're doing and the goal
   - **STATE** — what's done, what's in progress
   - **KEY DECISIONS** — choices made and why
   - **OPEN THREADS & NEXT STEPS** — the concrete actions to do next, in order
   - **KEY FILES & LOCATIONS** — exact paths, commands, URLs, IDs the successor needs
   - **GOTCHAS** — anything that will bite if forgotten

2. Save it AND pass the baton in one shot — pipe the markdown to the helper with `--baton`:
   ```bash
   cat << 'HANDOFF' | node "${CLAUDE_PLUGIN_ROOT}/bin/write-handoff.mjs" --baton
   <your handoff markdown>
   HANDOFF
   ```
   `--baton` writes the handoff, opens a FRESH session that takes over (it auto-recaps the handoff
   on open), and closes THIS Terminal window once the fresh session has consumed it — a true baton
   pass, one session at a time. (Omit `--baton` to only write the handoff without spawning/closing.)
   It's safe: the original window is closed ONLY after the fresh session confirms it took over, and
   never if the fresh session fails to start.

3. Tell the user briefly: "Handoff written — a fresh session is opening and will recap it; this
   window closes once it takes over." Then stop (the baton will close this session shortly).

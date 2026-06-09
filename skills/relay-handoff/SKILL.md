---
name: relay-handoff
description: |
  Write a rich handoff for the CURRENT session so a fresh Claude Code session can take over
  with a full new context window (instead of compacting). Use proactively when context is
  getting full, or before ending, to pass the baton cleanly. Trigger: /claude-relay:relay-handoff
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

2. Save it by piping the markdown to the helper:
   ```bash
   cat << 'HANDOFF' | node "$(dirname "$(command -v claude)")/../<plugin>/bin/write-handoff.mjs"
   <your handoff markdown>
   HANDOFF
   ```
   (Or call the plugin's `bin/write-handoff.mjs` directly via its `${CLAUDE_PLUGIN_ROOT}`.)

3. Tell the user: open a fresh terminal + `claude` in this same project directory — the
   SessionStart hook will detect the handoff and the new session takes over with a full window.
   (The PreCompact hook also writes one automatically at the compaction threshold.)

#!/bin/bash
# trantor handoff prompt (macOS) — shown when a session hits its context limit.
# Asks the user, with a timeout, whether to open a FRESH same-agent session that takes
# over via the handoff. Default (incl. timeout, or no UI) = open fresh. "Keep compacting" = skip.
#
# Usage: handoff-prompt.sh <project-dir> [timeout-seconds]
# Agent to spawn = $AGENT_CMD (default "claude") — same agent, fresh window.
DIR="${1:-$HOME}"
TIMEOUT="${2:-25}"
# The fresh session SELF-ANNOUNCES: it opens already recapping the handoff it took over, so it's never
# a confusing empty prompt. Single-quoted so it survives osascript->shell with no escaping (no apostrophes).
AGENT_CMD="${AGENT_CMD:-claude 'Recap the handoff you just took over — what was the previous session doing, and where do we continue? Then wait for me.'}"
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="$(basename "$DIR")"

MSG="trantor — context is at ~90% on $NAME. Hand off to a FRESH full-window session now? It loads this session's handoff and continues; this window then closes (baton pass). Cancel to keep working here."

# Best-effort timed dialog. On timeout, error, or no UI session -> empty -> we spawn (the default).
CHOICE="$(osascript -e "button returned of (display dialog \"${MSG//\"/\\\"}\" buttons {\"Keep working here\", \"Hand off\"} default button \"Hand off\" giving up after $TIMEOUT with title \"trantor\")" 2>/dev/null)"

if [ "$CHOICE" != "Keep working here" ]; then
  "$HERE/open-session.sh" "$DIR" "$AGENT_CMD"
fi

#!/bin/bash
# agent-bus handoff prompt (macOS) — shown when a session hits its context limit.
# Asks the user, with a timeout, whether to open a FRESH same-agent session that takes
# over via the handoff. Default (incl. timeout, or no UI) = open fresh. "Keep compacting" = skip.
#
# Usage: handoff-prompt.sh <project-dir> [timeout-seconds]
# Agent to spawn = $AGENT_CMD (default "claude") — same agent, fresh window.
DIR="${1:-$HOME}"
TIMEOUT="${2:-25}"
AGENT_CMD="${AGENT_CMD:-claude}"
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="$(basename "$DIR")"

MSG="agent-bus — this session's context window is full ($NAME). Open a FRESH session to take over with a full window? It loads a handoff of this session. (The current session keeps compacting either way.)"

# Best-effort timed dialog. On timeout, error, or no UI session -> empty -> we spawn (the default).
CHOICE="$(osascript -e "button returned of (display dialog \"${MSG//\"/\\\"}\" buttons {\"Keep compacting\", \"Open fresh session\"} default button \"Open fresh session\" giving up after $TIMEOUT with title \"agent-bus\")" 2>/dev/null)"

if [ "$CHOICE" != "Keep compacting" ]; then
  "$HERE/open-session.sh" "$DIR" "$AGENT_CMD"
fi

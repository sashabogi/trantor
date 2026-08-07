#!/bin/bash
# trantor/kimi handoff prompt (macOS) — shown when a Kimi session hits its context limit.
# Asks the user, with a timeout, whether to open a FRESH `kimi` session that takes over via the
# handoff. Default (incl. timeout, or no UI) = open fresh. "Keep working here" = skip.
#
# Usage: handoff-prompt.sh <project-dir> [timeout-seconds]
# Agent to spawn = $AGENT_CMD (default "kimi") — same agent, fresh window.
DIR="${1:-$HOME}"
TIMEOUT="${2:-25}"
# Kimi Code has no positional-prompt interactive mode (-p is non-interactive and exits), so the
# baton opens a plain interactive `kimi`: its SessionStart hook claims the pending handoff and
# injects it into context — any first prompt ("recap", "go") resumes the work.
AGENT_CMD="${AGENT_CMD:-kimi}"
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="$(basename "$DIR")"

MSG="trantor — context is at ~90% on $NAME. Hand off to a FRESH full-window kimi session now? It loads this session's handoff and continues; this window then closes (baton pass). Cancel to keep working here."

# Best-effort timed dialog. On timeout, error, or no UI session -> empty -> we spawn (the default).
CHOICE="$(osascript -e "button returned of (display dialog \"${MSG//\"/\\\"}\" buttons {\"Keep working here\", \"Hand off\"} default button \"Hand off\" giving up after $TIMEOUT with title \"trantor\")" 2>/dev/null)"

if [ "$CHOICE" != "Keep working here" ]; then
  /bin/bash "$HERE/open-session.sh" "$DIR" "$AGENT_CMD"
fi

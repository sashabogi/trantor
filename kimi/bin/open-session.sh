#!/bin/bash
# open-session.sh <dir> <command...> — open a NEW macOS Terminal window in <dir> running <command>.
# Lets a Kimi session spawn sibling terminal sessions (e.g. the handoff baton pass).
# Kimi port of bin/open-session.sh (identical logic; invoked via /bin/bash so no exec bit needed).
DIR="${1:-$HOME}"; shift; CMD="$*"
osascript >/dev/null <<OSA
tell application "Terminal"
  do script "cd " & quoted form of "$DIR" & " && $CMD"
  activate
end tell
OSA

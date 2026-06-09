#!/bin/bash
# open-session.sh <dir> <command...> — open a NEW macOS Terminal window in <dir> running <command>.
# Lets a Claude session spawn sibling terminal sessions (e.g. to test multi-session relay flows).
DIR="${1:-$HOME}"; shift; CMD="$*"
osascript >/dev/null <<OSA
tell application "Terminal"
  do script "cd " & quoted form of "$DIR" & " && $CMD"
  activate
end tell
OSA

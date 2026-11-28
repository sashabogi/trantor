#!/bin/bash
# open-session.sh <dir> <command...> — open a NEW macOS Terminal window in <dir> running <command>.
# Lets a Claude session spawn sibling terminal sessions (e.g. to test multi-session relay flows).
#
# #14531: the new window must not carry the caller's session identity. A Terminal session that
# kept HERDR_PANE_ID registered itself as the agent of a herdr pane it was not in (the app then
# attached to an empty pane), and one that kept CLAUDE_CODE_CHILD_SESSION ran with transcript
# saving off, so its conversation could never be resumed. Same list as lib/seats.mjs
# SESSION_IDENTITY_ENV, plus the rest of herdr's pane env.
DIR="${1:-$HOME}"; shift; CMD="$*"
SCRUB="unset HERDR_ENV HERDR_PANE_ID HERDR_TAB_ID HERDR_WORKSPACE_ID HERDR_SOCKET_PATH TRANTOR_ORCH CLAUDECODE CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID"
LINE="$SCRUB; cd $(printf '%q' "$DIR") && $CMD"
if [ "${TRANTOR_OPEN_SESSION_PRINT:-}" = "1" ]; then printf '%s\n' "$LINE"; exit 0; fi
osascript - "$LINE" >/dev/null <<'OSA'
on run argv
  tell application "Terminal"
    do script (item 1 of argv)
    activate
  end tell
end run
OSA

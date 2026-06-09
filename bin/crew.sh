#!/bin/bash
# agent-bus crew launcher — open visible terminal windows for helper agents and tear them down.
#
#   bin/crew.sh up codex gemini kimi deepseek    # one Terminal window per agent, in the CURRENT project dir
#   bin/crew.sh down                             # kill crew processes + close their windows (no dialogs)
#
# Each window runs that agent's CLI with a minimal kickoff: join the bus, announce yourself,
# then park on relay_wait(50) loops and follow instructions that arrive OVER THE BUS.
# The orchestrating agent sends the actual work contracts via relay_send after the crew is up.
#
# macOS (Terminal.app). Geometry: env CREW_RECT="X,Y,W,H" (default: right half of a 1440-pt
# display scaled by what AppleScript reports). State: ~/.agent-bus/crew-windows.txt
set -u
CMD="${1:-up}"; shift 2>/dev/null || true
DIR="$(pwd)"
PROJ="$(basename "$DIR")"
BUS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HOME/.agent-bus/crew-windows.txt"
mkdir -p "$HOME/.agent-bus"

down() {
  [ -f "$STATE" ] || { echo "no tracked crew windows"; return 0; }
  while read -r wid; do
    TTY=$(osascript -e "tell application \"Terminal\" to get tty of (first window whose id is $wid)" 2>/dev/null)
    if [ -n "$TTY" ]; then
      # SIGKILL everything on the tty, login included — TUIs trap SIGTERM, and Terminal
      # counts a live login as "a running process" and raises the Terminate dialog.
      for pid in $(ps -t "${TTY#/dev/}" -o pid= 2>/dev/null); do kill -9 "$pid" 2>/dev/null; done
    fi
  done < "$STATE"
  sleep 1
  while read -r wid; do
    osascript -e "tell application \"Terminal\" to close (first window whose id is $wid)" 2>/dev/null
  done < "$STATE"
  sleep 0.5  # dismiss any Terminate sheet that slipped through anyway
  osascript -e 'tell application "System Events" to tell process "Terminal"' \
            -e 'repeat with w in windows' -e 'try' \
            -e 'if exists sheet 1 of w then click button "Terminate" of sheet 1 of w' \
            -e 'end try' -e 'end repeat' -e 'end tell' >/dev/null 2>&1
  rm -f "$STATE"
  echo "crew torn down"
}
[ "$CMD" = "down" ] && { down; exit 0; }
[ "$CMD" != "up" ] && { echo "usage: crew.sh up <agent...> | crew.sh down"; exit 1; }
[ $# -eq 0 ] && { echo "usage: crew.sh up codex gemini kimi deepseek (any subset)"; exit 1; }

if [ "$(uname)" != "Darwin" ]; then
  echo "Window spawning is macOS-only. Run these manually, one per terminal, in $DIR:"
  for a in "$@"; do echo "  <$a's CLI> with the kickoff: join agent-bus, announce yourself, park on relay_wait(50) and follow bus instructions"; done
  exit 0
fi

# one-time wiring for every detected CLI (idempotent, backed up)
node "$BUS_DIR/bin/connect.mjs" | tail -n +2

down >/dev/null 2>&1  # idempotent relaunch

# generic kickoff (work contracts arrive over the bus afterwards)
kick() { # $1 agent
  echo "You are $1 on the agent-bus crew for project '$PROJ'. Do this now: 1) relay_status \"crew member ready\". 2) relay_send to \"all\": \"$1 reporting — window open, awaiting contract\". 3) Park: call relay_wait with timeout 50 repeatedly (NEVER higher — some MCP clients cap tool calls); when a message addressed to you arrives, follow its instructions, report progress on the bus, and move your Kanban card (relay_task_move) as you work."
}
# command per agent (override with CREW_CMD_<AGENT>)
cmd_for() {
  case "$1" in
    codex)    echo "codex --dangerously-bypass-approvals-and-sandbox \\\"\$(cat {K})\\\"";;
    gemini)   echo "gemini --yolo -i \\\"\$(cat {K})\\\"";;
    kimi)     echo "kimi --yolo -p \\\"\$(cat {K})\\\"";;
    deepseek|opencode) echo "opencode run \\\"\$(cat {K})\\\"";;
    claude)   echo "claude \\\"\$(cat {K})\\\" --permission-mode acceptEdits";;
    *)        echo "";;
  esac
}

# geometry: default = right half of the FIRST display; override with CREW_RECT="X,Y,W,H"
if [ -n "${CREW_RECT:-}" ]; then
  IFS=',' read -r GX GY GW GH <<< "$CREW_RECT"
else
  read -r _ _ SW SH <<< "$(osascript -e 'tell application "Finder" to get bounds of window of desktop' | tr ',' ' ')"
  GX=$(( SW / 2 )); GY=25; GW=$(( SW / 2 )); GH=$(( SH - 25 ))
fi
N=$#; COLS=2; [ $N -le 2 ] && COLS=1
ROWS=$(( (N + COLS - 1) / COLS ))
CW=$(( GW / COLS )); CH=$(( GH / ROWS ))

i=0
for AGENT in "$@"; do
  TPL=$(cmd_for "$AGENT")
  OVERRIDE_VAR="CREW_CMD_$(echo "$AGENT" | tr '[:lower:]' '[:upper:]')"
  TPL="${!OVERRIDE_VAR:-$TPL}"
  [ -z "$TPL" ] && { echo "  ✗ $AGENT: unknown CLI (set $OVERRIDE_VAR)"; continue; }
  KF="$HOME/.agent-bus/kick-$AGENT.txt"; kick "$AGENT" > "$KF"
  RUN="${TPL//\{K\}/$KF}"
  # deepseek/opencode may need provider keys from a local env file
  [ "$AGENT" = "deepseek" ] && [ -f "$HOME/.token-scrooge/.env" ] && RUN="set -a; source ~/.token-scrooge/.env; set +a; $RUN"
  C=$(( i % COLS )); R=$(( i / COLS ))
  X1=$(( GX + C * CW )); Y1=$(( GY + R * CH )); X2=$(( X1 + CW )); Y2=$(( Y1 + CH ))
  osascript \
    -e 'tell application "Terminal"' \
    -e "  set w to do script \"cd $DIR && clear && $RUN\"" \
    -e "  set custom title of w to \"$(echo "$AGENT" | tr '[:lower:]' '[:upper:]') — agent-bus crew\"" \
    -e "  set theWin to first window whose tabs contains w" \
    -e "  set bounds of theWin to {$X1, $Y1, $X2, $Y2}" \
    -e "  return id of theWin" \
    -e 'end tell' >> "$STATE"
  echo "  ✓ $AGENT window up"
  i=$(( i + 1 ))
done
echo "crew up in $DIR — they join the bus and park; send contracts with relay_send. Teardown: crew.sh down"

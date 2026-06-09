#!/bin/bash
# agent-bus crew launcher v2 — visible terminal windows that CANNOT silently die or silently fail.
#
#   bin/crew.sh up codex gemini kimi deepseek    # one window per agent, in the CURRENT project dir
#   bin/crew.sh down                             # kill crew processes + close windows (no dialogs)
#
# Each window runs bin/crew-runner.mjs: the CLI does one turn and exits; the RUNNER long-polls
# the bus (free, doubles as heartbeat) and resumes the CLI — with full context — whenever a
# message arrives. No model-side parking, no harness fights, no token burn while idle.
#
# Spawns are SERIALIZED and then VERIFIED on the bus (crew-verify.mjs); failures retry once and
# are reported loudly — the orchestrator never gets a green lie.
#
# Geometry: "crewRect": "X,Y,W,H" in ~/.agent-bus/config.json (or CREW_RECT env) — set once per
# machine; used for every spawn including respawns. Default: right half of the main display.
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
      # SIGKILL everything on the tty, login included — TUIs trap SIGTERM, and a live login
      # makes Terminal raise the "Terminate running processes?" dialog on close.
      for pid in $(ps -t "${TTY#/dev/}" -o pid= 2>/dev/null); do kill -9 "$pid" 2>/dev/null; done
    fi
  done < "$STATE"
  sleep 1
  while read -r wid; do
    osascript -e "tell application \"Terminal\" to close (first window whose id is $wid)" 2>/dev/null
  done < "$STATE"
  sleep 0.5
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
  echo "Window spawning is macOS-only. Run one per terminal, in $DIR:"
  for a in "$@"; do echo "  node $BUS_DIR/bin/crew-runner.mjs $a $DIR"; done
  exit 0
fi

# one-time wiring for every detected CLI (idempotent, backed up)
node "$BUS_DIR/bin/connect.mjs" | tail -n +2

# ---- geometry: CREW_RECT env > config.json crewRect > right half of main display ----
RECT="${CREW_RECT:-$(node -e 'try{const c=require(require("os").homedir()+"/.agent-bus/config.json");process.stdout.write(c.crewRect||"")}catch{}' 2>/dev/null)}"
if [ -n "$RECT" ]; then
  IFS=',' read -r GX GY GW GH <<< "$RECT"
else
  read -r _ _ SW SH <<< "$(osascript -e 'tell application "Finder" to get bounds of window of desktop' | tr ',' ' ')"
  GX=$(( SW / 2 )); GY=25; GW=$(( SW / 2 )); GH=$(( SH - 25 ))
fi

spawn_grid() {  # $@ = agents — (re)computes the grid for THIS batch and spawns serially
  local N=$# COLS=2
  [ $N -le 2 ] && COLS=1
  local ROWS=$(( (N + COLS - 1) / COLS ))
  local CW=$(( GW / COLS )) CH=$(( GH / ROWS ))
  local i=0 AGENT
  for AGENT in "$@"; do
    local C=$(( i % COLS )) R=$(( i / COLS ))
    local X1=$(( GX + C * CW )) Y1=$(( GY + R * CH ))
    osascript \
      -e 'tell application "Terminal"' \
      -e "  set w to do script \"cd $DIR && clear && node $BUS_DIR/bin/crew-runner.mjs $AGENT $DIR\"" \
      -e "  set custom title of w to \"$(echo "$AGENT" | tr '[:lower:]' '[:upper:]') — agent-bus crew\"" \
      -e "  set theWin to first window whose tabs contains w" \
      -e "  set bounds of theWin to {$X1, $Y1, $(( X1 + CW )), $(( Y1 + CH ))}" \
      -e "  return id of theWin" \
      -e 'end tell' >> "$STATE" 2>/dev/null && echo "  → $AGENT window spawned" || echo "  ✗ $AGENT osascript spawn ERROR"
    sleep 1.2   # serialize — rapid-fire 'do script' calls race and silently drop windows
    i=$(( i + 1 ))
  done
}

echo "— spawning crew (serialized) —"
spawn_grid "$@"

echo "— verifying on the bus (the spawn is not the truth; the bus is) —"
VER=$(node "$BUS_DIR/bin/crew-verify.mjs" "$PROJ" "$@" --timeout 30)
echo "$VER"
RETRY=$(echo "$VER" | grep "^FAILED:" | cut -d: -f2 | tr ',' ' ')
if [ -n "${RETRY// }" ]; then
  echo "— retrying failed spawns: $RETRY —"
  spawn_grid $RETRY
  VER2=$(node "$BUS_DIR/bin/crew-verify.mjs" "$PROJ" $RETRY --timeout 30)
  echo "$VER2"
  STILL=$(echo "$VER2" | grep "^FAILED:" | cut -d: -f2)
  if [ -n "$STILL" ]; then
    echo ""
    echo "✗✗ CREW INCOMPLETE — these agents are NOT on the bus: $STILL"
    echo "   Do NOT assign them work. Investigate their windows or run: crew.sh up ${STILL//,/ }"
    exit 1
  fi
fi
echo "— crew verified on the bus. Send contracts with relay_send; runners keep agents alive for free. Teardown: crew.sh down —"

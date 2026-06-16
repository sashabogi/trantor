#!/bin/bash
# trantor crew launcher v2 — visible terminal windows that CANNOT silently die or silently fail.
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

# --task/--difficulty drive LAZY live-model selection for provider-only specs (agent:provider).
# An agent spec is one of: `codex` (CLI default) · `opencode:zai-coding-plan` (provider only →
# pick the best live model now) · `opencode:zai-coding-plan/glm-5.2` (full pin, used as-is).
TASK="code"; DIFF="medium"; _ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --task) TASK="${2:-code}"; shift 2 || shift ;;
    --difficulty|--diff) DIFF="${2:-medium}"; shift 2 || shift ;;
    *) _ARGS+=("$1"); shift ;;
  esac
done
if [ ${#_ARGS[@]} -gt 0 ]; then set -- "${_ARGS[@]}"; else set --; fi
[ $# -eq 0 ] && { echo "usage: crew.sh up [--task K --difficulty D] codex gemini kimi deepseek (agent:provider picks a live model; agent:provider/model pins one)"; exit 1; }

# scrooge (the model-routing brain) is bundled with this trantor install; fall back to PATH.
SCROOGE="$BUS_DIR/engine/bin/scrooge"
[ -f "$SCROOGE" ] || SCROOGE="$(command -v scrooge 2>/dev/null || echo scrooge)"

# resolve_model <agent> <provider> <task> <diff> -> echoes a runner-ready model id, or empty
# (→ CLI default). Enumeration is CLI-aware and never guesses an endpoint: opencode-managed
# agents list via `opencode models <provider>`; others self-enumerate via the provider's /models.
resolve_model() {
  local agent="$1" provider="$2" task="$3" diff="$4" cands="" out=""
  case "$agent" in
    opencode|deepseek)
      cands="$(opencode models "$provider" 2>/dev/null | tr '\n' ' ')"
      [ -n "$cands" ] || { echo "[crew] no live models via 'opencode models $provider' — CLI default" >&2; return 0; }
      out="$(python3 "$SCROOGE" route --candidates "$cands" -t "$task" -d "$diff" --json 2>/dev/null)" ;;
    *)
      out="$(python3 "$SCROOGE" route --provider "$provider" -t "$task" -d "$diff" --json 2>/dev/null)" ;;
  esac
  [ -n "$out" ] || { echo "[crew] live model selection failed for $agent:$provider — CLI default" >&2; return 0; }
  printf '%s' "$out" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("qualified") or "")
except Exception: pass' 2>/dev/null
}

if [ "$(uname)" != "Darwin" ]; then
  echo "Window spawning is macOS-only. Run one per terminal, in $DIR:"
  for a in "$@"; do echo "  node $BUS_DIR/bin/crew-runner.mjs $a $DIR"; done
  exit 0
fi

# one-time wiring for every detected CLI (idempotent, backed up)
node "$BUS_DIR/bin/connect.mjs" | tail -n +2

# ---- geometry: AUTO-DETECTED from the screen you're working on (never hard-coded coords).
# NSScreen.mainScreen = the display with keyboard focus; visibleFrame excludes menu bar/Dock.
# Crew tiles into the RIGHT 58% of THAT screen (left side stays for dashboard/main terminal).
# One-off override: CREW_RECT="X,Y,W,H" env (no persistent config — display setups change).
if [ -n "${CREW_RECT:-}" ]; then
  IFS=',' read -r GX GY GW GH <<< "$CREW_RECT"
else
  eval "$(osascript -l JavaScript -e '
    ObjC.import("AppKit");
    const f=$.NSScreen.mainScreen.visibleFrame, prim=$.NSScreen.screens.objectAtIndex(0).frame;
    const yTop = prim.size.height - (f.origin.y + f.size.height);
    const x=Math.round(f.origin.x), y=Math.round(yTop), w=Math.round(f.size.width), h=Math.round(f.size.height);
    `SX=${x} SY=${y} SW=${w} SH=${h}`' 2>/dev/null)"
  if [ -z "${SW:-}" ]; then  # fallback: primary display via Finder
    read -r SX SY SW SH <<< "$(osascript -e 'tell application "Finder" to get bounds of window of desktop' | tr ',' ' ')"
    SY=25; SH=$(( SH - 25 ))
  fi
  GX=$(( SX + SW * 42 / 100 )); GY=$SY; GW=$(( SW * 58 / 100 )); GH=$SH
fi
echo "— crew area: ${GW}x${GH} at ${GX},${GY} (focused screen, auto-detected) —"

spawn_grid() {  # $@ = agents — (re)computes the grid for THIS batch and spawns serially
  local N=$# COLS=2
  [ $N -le 2 ] && COLS=1
  local ROWS=$(( (N + COLS - 1) / COLS ))
  local CW=$(( GW / COLS )) CH=$(( GH / ROWS ))
  local i=0 SPEC AGENT FIELD MODEL
  for SPEC in "$@"; do
    AGENT="${SPEC%%:*}"                       # agent[:provider[/model]] — model rides in as CREW_MODEL
    FIELD=""; [ "$SPEC" != "$AGENT" ] && FIELD="${SPEC#*:}"
    MODEL=""
    if [ -n "$FIELD" ]; then
      case "$FIELD" in
        */*) MODEL="$FIELD" ;;                                          # full pin: provider/model
        *)   MODEL="$(resolve_model "$AGENT" "$FIELD" "$TASK" "$DIFF")"  # provider only: pick live now
             if [ -n "$MODEL" ]; then echo "  → $AGENT: live model $MODEL ($FIELD · $TASK/$DIFF)"
             else echo "  → $AGENT: '$FIELD' live selection unavailable — CLI default"; fi ;;
      esac
    fi
    local C=$(( i % COLS )) R=$(( i / COLS ))
    local X1=$(( GX + C * CW )) Y1=$(( GY + R * CH ))
    osascript \
      -e 'tell application "Terminal"' \
      -e "  set w to do script \"cd $DIR && clear && CREW_MODEL=$MODEL node $BUS_DIR/bin/crew-runner.mjs $AGENT $DIR\"" \
      -e "  set custom title of w to \"$(echo "$AGENT" | tr '[:lower:]' '[:upper:]') — trantor crew\"" \
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
AGENTS_ONLY=$(for a in "$@"; do printf "%s " "${a%%:*}"; done)
VER=$(node "$BUS_DIR/bin/crew-verify.mjs" "$PROJ" $AGENTS_ONLY --timeout 30)
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

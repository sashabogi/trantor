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
# Canonical project key: the orchestrator's RELAY_PROJECT wins, else the GIT REPO ROOT
# basename (stable across subdirs), else the cwd basename. The crew inherits this exact
# key so one repo = one lane (no host "builtbetter.ai" vs crew "builtbetter" split).
PROJ="${RELAY_PROJECT:-$(basename "$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null || echo "$DIR")")}"
BUS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HOME/.agent-bus/crew-windows.txt"
mkdir -p "$HOME/.agent-bus"

down() {
  [ -f "$STATE" ] || { echo "no tracked crew windows"; return 0; }
  while IFS=$'\t' read -r a wid; do
    [ -n "${wid:-}" ] || wid="$a"          # back-compat: old STATE stored bare window ids
    TTY=$(osascript -e "tell application \"Terminal\" to get tty of (first window whose id is $wid)" 2>/dev/null)
    if [ -n "$TTY" ]; then
      # SIGKILL everything on the tty, login included — TUIs trap SIGTERM, and a live login
      # makes Terminal raise the "Terminate running processes?" dialog on close.
      for pid in $(ps -t "${TTY#/dev/}" -o pid= 2>/dev/null); do kill -9 "$pid" 2>/dev/null; done
    fi
  done < "$STATE"
  sleep 1
  while IFS=$'\t' read -r a wid; do
    [ -n "${wid:-}" ] || wid="$a"
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
case "$CMD" in up|swap) ;; *) echo "usage: crew.sh up <agent...> | crew.sh swap <oldAgent> <newAgent[:provider[/model]]> | crew.sh down"; exit 1 ;; esac

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
    opencode|deepseek|openrouter)
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

# epoch_ms: milliseconds since the epoch, captured BEFORE a spawn so crew-verify can count an
# agent the moment it registers (even "booting"), instead of racing its own start time. A slow
# first turn (opencode+GLM cold start ~40s) means no heartbeat for the whole turn; anchoring the
# verifier to this pre-spawn epoch lets the early "booting" registration satisfy it.
epoch_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

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
    # `trantor up openrouter` (no provider) → default the opencode provider to openrouter so it
    # live-selects from the OpenRouter catalog instead of falling back to opencode's default model.
    [ "$AGENT" = "openrouter" ] && [ -z "$FIELD" ] && FIELD="openrouter"
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
    local X1=$(( GX + C * CW )) Y1=$(( GY + R * CH )) WID=""
    WID="$(osascript \
      -e 'tell application "Terminal"' \
      -e "  set w to do script \"cd $DIR && clear && CREW_MODEL=$MODEL RELAY_PROJECT=$PROJ node $BUS_DIR/bin/crew-runner.mjs $AGENT $DIR\"" \
      -e "  set custom title of w to \"$(echo "$AGENT" | tr '[:lower:]' '[:upper:]') — trantor crew\"" \
      -e "  set theWin to first window whose tabs contains w" \
      -e "  set bounds of theWin to {$X1, $Y1, $(( X1 + CW )), $(( Y1 + CH ))}" \
      -e "  return id of theWin" \
      -e 'end tell' 2>/dev/null)"
    if [ -n "$WID" ]; then printf '%s\t%s\n' "$AGENT" "$WID" >> "$STATE"; echo "  → $AGENT window spawned"; else echo "  ✗ $AGENT osascript spawn ERROR"; fi
    sleep 1.2   # serialize — rapid-fire 'do script' calls race and silently drop windows
    i=$(( i + 1 ))
  done
}

# swap <oldAgent> <newSpec>: replace a live agent (e.g. one reported exhausted) with a fresh
# one whose model is live-selected. Tears down the old agent's window, spawns the new spec.
swap() {
  local OLD="${1:-}" NEWSPEC="${2:-}"
  [ -n "$OLD" ] && [ -n "$NEWSPEC" ] || { echo "usage: trantor swap <oldAgent> <newAgent[:provider[/model]]> [--task K --difficulty D]"; exit 1; }
  if [ -f "$STATE" ]; then
    local tmp="$STATE.tmp"; : > "$tmp"
    while IFS=$'\t' read -r a wid; do
      [ -n "${wid:-}" ] || { wid="$a"; a=""; }
      if [ "$a" = "$OLD" ]; then
        echo "— tearing down old agent '$OLD' (window $wid) —"
        local TTY; TTY=$(osascript -e "tell application \"Terminal\" to get tty of (first window whose id is $wid)" 2>/dev/null)
        [ -n "$TTY" ] && for pid in $(ps -t "${TTY#/dev/}" -o pid= 2>/dev/null); do kill -9 "$pid" 2>/dev/null; done
        sleep 0.5
        osascript -e "tell application \"Terminal\" to close (first window whose id is $wid)" 2>/dev/null
      else
        printf '%s\t%s\n' "$a" "$wid" >> "$tmp"
      fi
    done < "$STATE"
    mv "$tmp" "$STATE"
  fi
  echo "— spawning replacement: $NEWSPEC ($TASK/$DIFF) —"
  local SWAP_EPOCH; SWAP_EPOCH=$(epoch_ms)
  spawn_grid "$NEWSPEC"
  local NEWAGENT="${NEWSPEC%%:*}"
  echo "— verifying replacement on the bus —"
  node "$BUS_DIR/bin/crew-verify.mjs" "$PROJ" "$NEWAGENT" --since "$SWAP_EPOCH" --timeout 30
  echo "— swapped. RESEND the contract to '$NEWAGENT' (it joined fresh with no context). —"
}

if [ "$CMD" = "swap" ]; then swap "$@"; exit 0; fi

# spec_for_agent <agent> <spec...>: echo the FULL original spec (agent:provider[/model]) whose
# agent part matches — so a retry respawns on the SAME live-selected model, not the CLI default.
spec_for_agent() { local want="$1"; shift; local s; for s in "$@"; do [ "${s%%:*}" = "$want" ] && { printf '%s' "$s"; return; }; done; printf '%s' "$want"; }

echo "— spawning crew (serialized) —"
SPAWN_EPOCH=$(epoch_ms)
spawn_grid "$@"

echo "— verifying on the bus (the spawn is not the truth; the bus is) —"
AGENTS_ONLY=$(for a in "$@"; do printf "%s " "${a%%:*}"; done)
VER=$(node "$BUS_DIR/bin/crew-verify.mjs" "$PROJ" $AGENTS_ONLY --since "$SPAWN_EPOCH" --timeout 30)
echo "$VER"
RETRY=$(echo "$VER" | grep "^FAILED:" | cut -d: -f2 | tr ',' ' ')
if [ -n "${RETRY// }" ]; then
  # map failed agent names back to their FULL specs (preserve provider/model on respawn)
  RETRY_SPECS=""; for a in $RETRY; do RETRY_SPECS="$RETRY_SPECS $(spec_for_agent "$a" "$@")"; done
  echo "— retrying failed spawns:$RETRY_SPECS —"
  RETRY_EPOCH=$(epoch_ms)
  spawn_grid $RETRY_SPECS
  VER2=$(node "$BUS_DIR/bin/crew-verify.mjs" "$PROJ" $RETRY --since "$RETRY_EPOCH" --timeout 30)
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

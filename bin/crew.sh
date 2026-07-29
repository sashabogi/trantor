#!/bin/bash
# trantor crew launcher v3 — visible, GROUPED, per-project crews that can't silently die and that ONE
# session's teardown can't nuke out from under ANOTHER session's crew.
#
#   bin/crew.sh up codex glm kimi deepseek   # bring up THIS project's crew (tmux panes, or Terminal windows)
#   bin/crew.sh down                          # tear down ONLY THIS PROJECT's crew (scoped, prints what it kills)
#   bin/crew.sh down codex                    # tear down ONE seat
#   bin/crew.sh down --all --yes              # tear down EVERY project's crew (global; --yes required)
#   bin/crew.sh swap <oldAgent> <newSpec>     # replace one seat with a live-selected model
#
# WHY v3: v2 tracked windows in ONE global ~/.agent-bus/crew-windows.txt as bare `AGENT<TAB>WID` rows — no
# project — so `down` from any session killed EVERY crew on the machine, mid-flight. And N free-floating
# Terminal windows (2x2, then half-screen at 5+) were impossible to tell apart when several sessions each ran
# a crew. v3 fixes both: STATE rows are `PROJECT<TAB>KIND<TAB>AGENT<TAB>HANDLE`, teardown is PROJECT-SCOPED,
# and the crew launches as ONE tmux session `trantor:<project>` (named panes you see at once) — or, if tmux
# isn't installed, the legacy per-agent Terminal grid with the window titled `<PROJECT> · <AGENT>`.
#
# Each pane/window runs bin/crew-runner.mjs: the CLI does one turn and exits; the RUNNER long-polls the bus
# (free, doubles as heartbeat) and resumes the CLI — with full context — whenever a message arrives.
#
# CREW_DRY_RUN=1 prints every spawn/kill instead of doing it (used by test-crew.sh to prove teardown scoping).
set -u
CMD="${1:-up}"; shift 2>/dev/null || true
DIR="$(pwd)"
# Canonical project key: the orchestrator's RELAY_PROJECT wins, else the GIT REPO ROOT basename (stable
# across subdirs), else the cwd basename. The crew inherits this exact key so one repo = one lane.
PROJ="${RELAY_PROJECT:-$(basename "$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null || echo "$DIR")")}"
BUS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HOME/.agent-bus/crew-windows.txt"
mkdir -p "$HOME/.agent-bus"
TMUX_SESS="trantor:$PROJ"                                  # one tmux session per project
HAVE_TMUX=0; command -v tmux >/dev/null 2>&1 && HAVE_TMUX=1
# cmux (https://cmux — a Ghostty-based multiplexer) is the PREFERRED grouping when installed: one workspace
# TAB per project, seats tiled inside it, scoped teardown via `close tab`. Driven by AppleScript (Apple
# Events) — NOT the control socket — so it needs NO socket password (the socket denies external processes
# by default; AppleScript bypasses that, exactly like we already script Terminal.app).
HAVE_CMUX=0; [ -d "/Applications/cmux.app" ] && HAVE_CMUX=1
# explicit override (user preference or tests): CREW_MUX=cmux|tmux|terminal forces the grouping UI.
case "${CREW_MUX:-}" in
  cmux)     HAVE_CMUX=1; HAVE_TMUX=0 ;;
  tmux)     HAVE_CMUX=0; HAVE_TMUX=1 ;;
  terminal) HAVE_CMUX=0; HAVE_TMUX=0 ;;
esac
SEATDIR="$HOME/.agent-bus/seats"; mkdir -p "$SEATDIR"
DRY="${CREW_DRY_RUN:-0}"
run() { if [ "$DRY" = "1" ]; then echo "[dry] $*"; else eval "$*"; fi; }

# ── STATE helpers ──────────────────────────────────────────────────────────────────────────────────
# Row schema (TSV): PROJECT <TAB> KIND <TAB> AGENT <TAB> HANDLE
#   KIND=win    HANDLE=Terminal window id           (one row per agent)
#   KIND=tmux   HANDLE=tmux pane id (e.g. %3)        (one row per agent; session = trantor:PROJECT)
#   KIND=attach HANDLE=Terminal window id            (the single window attached to the tmux session)
# Legacy v2 rows are bare `AGENT <TAB> WID` (2 fields, NO project) — read as PROJECT="" KIND=win.
record_state() { [ "$DRY" = "1" ] && return 0; printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$STATE"; }

# parse a STATE line into globals RP/RK/RA/RH (PROJECT/KIND/AGENT/HANDLE), handling legacy 2-field rows.
# We split the RAW line by field COUNT rather than round-tripping through a rebuilt string: tab is IFS
# whitespace, so `read` COLLAPSES a leading empty field — a rebuilt "<TAB>win<TAB>…" would mis-parse an
# empty PROJECT as KIND. New rows always carry a non-empty PROJECT (4 fields); only legacy rows are 2 fields.
_parse_row() { # $1 = line
  local -a f; IFS=$'\t' read -r -a f <<< "$1"
  if [ "${#f[@]}" -ge 4 ]; then RP="${f[0]}"; RK="${f[1]}"; RA="${f[2]}"; RH="${f[3]}"
  elif [ "${#f[@]}" -eq 2 ]; then RP=""; RK="win"; RA="${f[0]}"; RH="${f[1]}"      # legacy AGENT<TAB>WID
  else RP=""; RK="win"; RA="${f[0]:-}"; RH="${f[1]:-}"; fi
}

# close a Terminal window + SIGKILL everything on its tty (TUIs trap SIGTERM; a live login makes Terminal
# raise the "Terminate running processes?" dialog on close).
_kill_win() { # $1 = window id
  local wid="$1" tty pid
  [ -n "$wid" ] || return 0
  tty=$(osascript -e "tell application \"Terminal\" to get tty of (first window whose id is $wid)" 2>/dev/null)
  if [ -n "$tty" ]; then for pid in $(ps -t "${tty#/dev/}" -o pid= 2>/dev/null); do run "kill -9 $pid 2>/dev/null"; done; fi
  run "osascript -e 'tell application \"Terminal\" to close (first window whose id is $wid)' 2>/dev/null"
}

# ── cmux helpers ─────────────────────────────────────────────────────────────────────────────────
# The cmux CLI lives inside the app bundle; prefer it on PATH (we symlink it on `up`), else full path.
CMUX_BIN="$(command -v cmux 2>/dev/null)"; [ -n "$CMUX_BIN" ] || CMUX_BIN="/Applications/cmux.app/Contents/Resources/bin/cmux"
_cmux() { CMUX_QUIET=1 "$CMUX_BIN" "$@"; }            # quiet CLI wrapper (suppresses alias/notice chatter)
_CMUX_OK=""                                          # cached: does the control socket accept us (allowAll)?
_cmux_ok() {
  [ -n "$_CMUX_OK" ] && { [ "$_CMUX_OK" = "1" ] && return 0 || return 1; }
  if [ "$HAVE_CMUX" = "1" ] && _cmux ping >/dev/null 2>&1; then _CMUX_OK=1; return 0; fi
  _CMUX_OK=0; return 1
}
# resolve a freshly-created workspace REF (workspace:N) → its stable UUID (survives index shifts).
_cmux_ws_uuid() {   # $1 = ref like "workspace:3"
  _cmux workspace list --id-format both --json 2>/dev/null | REF="$1" node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const o=JSON.parse(d.slice(d.search(/[\[{]/)));
const a=Array.isArray(o)?o:(o.workspaces||[]);const w=a.find(x=>x.ref===process.env.REF);process.stdout.write(w?w.id:"");}catch(e){}});'
}

# A per-seat LAUNCHER script — avoids escaping a complex command into the CLI/AppleScript, and sets the pane
# title via OSC (cmux surface names are read-only to rename-tab, so the seat labels itself `<AGENT> · <PROJ>`).
_seat_launcher() {   # $1=agent  $2=full runner command → echoes the launcher path
  local f="$SEATDIR/${PROJ}-$1.sh"
  { printf '#!/bin/bash\n'; printf 'printf "\\033]0;%%s\\007" %q\n' "$1 · $PROJ"; printf '%s\n' "$2"; } > "$f"
  printf '%s' "$f"
}
# Teardown prefers the control socket (close-workspace/close-surface by UUID); falls back to AppleScript
# (Apple Events, no allowAll needed) — object UUIDs are the same in both worlds.
_cmux_close_tab() {   # $1 = workspace uuid → close the whole project workspace (all its seats)
  [ "$DRY" = "1" ] && { echo "[dry] cmux close-workspace $1"; return 0; }
  if _cmux_ok; then _cmux close-workspace --workspace "$1" >/dev/null 2>&1 && return 0; fi
  osascript 2>/dev/null <<OSA
tell application "cmux"
  repeat with w in windows
    repeat with tt in tabs of w
      if (id of tt) is "$1" then close tab tt
    end repeat
  end repeat
end tell
OSA
}
_cmux_close_term() {  # $1 = surface uuid → close a single seat
  [ "$DRY" = "1" ] && { echo "[dry] cmux close-surface $1"; return 0; }
  if _cmux_ok; then _cmux close-surface --surface "$1" >/dev/null 2>&1 && return 0; fi
  osascript 2>/dev/null <<OSA
tell application "cmux"
  repeat with tr in terminals
    if (id of tr) is "$1" then close tr
  end repeat
end tell
OSA
}

# ── down: PROJECT-SCOPED teardown (never touches another project's crew) ─────────────────────────────
usage_down() {
  cat <<EOF
usage: trantor down [<agent>...] [--all] [--yes]
  trantor down              tear down THIS project's crew ($PROJ)
  trantor down codex glm    tear down only those seats in this project
  trantor down --all --yes  tear down EVERY project's crew on this machine (--yes required)
EOF
}
down() {
  local WANT_ALL=0 WANT_YES=0 AGENTS=() a
  for a in "$@"; do case "$a" in
    --all) WANT_ALL=1 ;;
    --yes|-y) WANT_YES=1 ;;
    --help|-h) usage_down; return 0 ;;
    --*) echo "trantor down: unknown flag '$a'"; usage_down; return 1 ;;
    *) AGENTS+=("$a") ;;
  esac; done
  [ -f "$STATE" ] || { echo "no tracked crew windows"; return 0; }
  local SCOPE_DESC; [ "$WANT_ALL" = "1" ] && SCOPE_DESC="all projects" || SCOPE_DESC="project \"$PROJ\""

  # collect the rows in scope + build a human kill-list. `scoped` entries are joined with '|' (NOT a tab):
  # tab is IFS whitespace, so re-splitting a tab-joined string would collapse an empty leading PROJECT.
  local scoped=() line killlist="" seentmux=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    _parse_row "$line"                                       # → RP RK RA RH
    # scope: --all → every row; else → ONLY this project's rows. Legacy (project-less, pre-v3) rows are
    # SKIPPED by a scoped down — we can't prove they're ours, and killing another project's crew is the exact
    # bug we're fixing. `trantor down --all` reaches them; otherwise they self-heal via prune_dead_state.
    if [ "$WANT_ALL" != "1" ] && [ "$RP" != "$PROJ" ]; then continue; fi
    if [ "${#AGENTS[@]}" -gt 0 ]; then                       # agent filter (if specific seats named)
      local match=0 want; for want in "${AGENTS[@]}"; do [ "$RA" = "$want" ] && match=1; done
      [ "$match" = "1" ] || continue
    fi
    scoped+=("$RP|$RK|$RA|$RH")
    case "$RK" in attach|cmuxws) continue ;; esac       # infra rows (attach window / cmux workspace) — not seats
    killlist="$killlist  • ${RP:-<legacy>} · $RA ($RK)"$'\n'
  done < "$STATE"

  if [ "${#scoped[@]}" -eq 0 ]; then echo "nothing to tear down for $SCOPE_DESC"; return 0; fi
  echo "— tearing down ($SCOPE_DESC):"; printf '%s' "$killlist"
  if [ "$WANT_ALL" = "1" ] && [ "$WANT_YES" != "1" ]; then
    echo "— this is EVERY project's crew. Re-run with --yes to confirm:  trantor down --all --yes"; return 0
  fi

  # execute. Per-project teardown: cmux → close the workspace tab; tmux → kill the session; Terminal → close
  # each window. Per-seat teardown (agents named): cmux → close that terminal; tmux → kill that pane.
  local s P2 K2 A2 H2
  for s in "${scoped[@]}"; do
    IFS='|' read -r P2 K2 A2 H2 <<< "$s"
    case "$K2" in
      cmuxws) [ "${#AGENTS[@]}" -gt 0 ] || _cmux_close_tab "$H2" ;;   # whole workspace (no specific seats)
      cmux)   [ "${#AGENTS[@]}" -gt 0 ] && _cmux_close_term "$H2" ;;  # a single seat's pane
      tmux)
        if [ "${#AGENTS[@]}" -gt 0 ]; then run "tmux kill-pane -t '$H2' 2>/dev/null"      # per-seat
        else
          local sess="trantor:$P2"
          case " $seentmux " in *" $sess "*) : ;; *) run "tmux kill-session -t '$sess' 2>/dev/null"; seentmux="$seentmux $sess" ;; esac
        fi ;;
      win|attach) { [ "${#AGENTS[@]}" -gt 0 ] && [ "$K2" = "attach" ]; } && continue; _kill_win "$H2" ;;
    esac
  done

  # rewrite STATE minus the rows we tore down (leaves OTHER projects' rows intact)
  if [ "$DRY" != "1" ]; then
    local tmp="$STATE.tmp"; : > "$tmp"
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      _parse_row "$line"
      local drop=0
      for s in "${scoped[@]}"; do [ "$s" = "$RP|$RK|$RA|$RH" ] && drop=1; done
      [ "$drop" = "1" ] || printf '%s\t%s\t%s\t%s\n' "$RP" "$RK" "$RA" "$RH" >> "$tmp"
    done < "$STATE"
    mv "$tmp" "$STATE"
    [ -s "$STATE" ] || rm -f "$STATE"
  fi
  echo "— crew torn down ($SCOPE_DESC)"
}
[ "$CMD" = "down" ] && { down "$@"; exit $?; }
case "$CMD" in up|swap) ;; *) echo "usage: crew.sh up <agent...> | crew.sh swap <old> <new[:provider[/model]]> | crew.sh down [<agent>...] [--all --yes]"; exit 1 ;; esac

# self-heal: drop STATE rows whose Terminal window is already gone (dead crews from past sessions), so the
# file doesn't accumulate ghosts across ups. tmux rows are validated by their session existing.
prune_dead_state() {
  [ -f "$STATE" ] || return 0
  [ "$DRY" = "1" ] && return 0
  local tmp="$STATE.tmp" line alive
  : > "$tmp"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    _parse_row "$line"                                       # → RP RK RA RH
    alive=1
    if [ "$RK" = "win" ] || [ "$RK" = "attach" ]; then
      [ -n "$(osascript -e "tell application \"Terminal\" to get id of (first window whose id is $RH)" 2>/dev/null)" ] || alive=0
    elif [ "$RK" = "tmux" ]; then
      tmux has-session -t "trantor:$RP" 2>/dev/null || alive=0
    fi
    [ "$alive" = "1" ] && printf '%s\t%s\t%s\t%s\n' "$RP" "$RK" "$RA" "$RH" >> "$tmp"
  done < "$STATE"
  mv "$tmp" "$STATE"; [ -s "$STATE" ] || rm -f "$STATE"
}

# --task/--difficulty drive LAZY live-model selection for provider-only specs (agent:provider).
TASK="code"; DIFF="medium"; _ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --task) TASK="${2:-code}"; shift 2 || shift ;;
    --difficulty|--diff) DIFF="${2:-medium}"; shift 2 || shift ;;
    *) _ARGS+=("$1"); shift ;;
  esac
done
if [ ${#_ARGS[@]} -gt 0 ]; then set -- "${_ARGS[@]}"; else set --; fi
[ $# -eq 0 ] && { echo "usage: crew.sh up [--task K --difficulty D] codex glm kimi deepseek (agent:provider picks a live model; agent:provider/model pins one)"; exit 1; }

# scrooge (the model-routing brain) is bundled with this trantor install; fall back to PATH.
SCROOGE="$BUS_DIR/engine/bin/scrooge"
[ -f "$SCROOGE" ] || SCROOGE="$(command -v scrooge 2>/dev/null || echo scrooge)"

# resolve_model <agent> <provider> <task> <diff> -> echoes a runner-ready model id, or empty (→ CLI default).
resolve_model() {
  local agent="$1" provider="$2" task="$3" diff="$4" cands="" out=""
  cands="$(opencode models "$provider" 2>/dev/null | tr '\n' ' ')"
  if [ -n "$cands" ]; then
    out="$(python3 "$SCROOGE" route --candidates "$cands" -t "$task" -d "$diff" --json 2>/dev/null)"
  else
    out="$(python3 "$SCROOGE" route --provider "$provider" -t "$task" -d "$diff" --json 2>/dev/null)"
  fi
  [ -n "$out" ] || { echo "[crew] live model selection failed for $agent:$provider — CLI default" >&2; return 0; }
  printf '%s' "$out" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("qualified") or "")
except Exception: pass' 2>/dev/null
}

epoch_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

# resolve_spec <spec> -> sets AGENT + MODEL globals (live-selects a provider-only spec).
AGENT=""; MODEL=""
resolve_spec() {
  local SPEC="$1" FIELD
  AGENT="${SPEC%%:*}"; MODEL=""
  # Replace, never stack. Reaps here — as a plain statement — because the alternative home, RUN_CMD,
  # is always invoked as `cmd="$(RUN_CMD)"`, and command substitution would swallow run()'s output
  # into the launcher string. AGENT is set above and DIR is fixed, so this is the earliest safe point.
  reap_seat
  FIELD=""; [ "$SPEC" != "$AGENT" ] && FIELD="${SPEC#*:}"
  [ "$AGENT" = "openrouter" ] && [ -z "$FIELD" ] && FIELD="openrouter"
  if [ -n "$FIELD" ]; then
    case "$FIELD" in
      */*) MODEL="$FIELD" ;;
      *)   MODEL="$(resolve_model "$AGENT" "$FIELD" "$TASK" "$DIFF")"
           if [ -n "$MODEL" ]; then echo "  → $AGENT: live model $MODEL ($FIELD · $TASK/$DIFF)"
           else echo "  → $AGENT: '$FIELD' live selection unavailable — CLI default"; fi ;;
    esac
  fi
}
# Kill any runner ALREADY serving this exact agent+project before starting another.
#
# Without this, `trantor up <agent>` ADDS a runner instead of replacing one — and every duplicate
# long-polls the SAME inbox, so a single contract wakes N runners and each burns a full CLI turn on
# the same card, racing to edit the same files. Observed 2026-07-29 on one project: codex x2, glm x3,
# deepseek x3; three byte-identical "#3931 doing" broadcasts seconds apart; an OpenRouter key at $55
# against a $20 cap; a seat blowing its context window at 362k tokens. It read as heavy usage. It was
# duplicated usage.
#
# Scoped to agent+project on purpose: re-firing one seat must not disturb its siblings, and a crew in
# another project is never ours to touch.
reap_seat() {
  local pid
  for pid in $(pgrep -f "crew-runner\.mjs $AGENT $DIR" 2>/dev/null); do
    run "kill -9 $pid 2>/dev/null"
  done
}
# RUN_CMD must stay PURE: every caller invokes it as `cmd="$(RUN_CMD)"`, i.e. command substitution,
# which captures ALL stdout. Anything that prints — including run()'s `[dry]` echo — would be swallowed
# into the command string and end up inside the launcher. The reap therefore lives in resolve_spec(),
# which every spawn path calls as a plain statement immediately before this.
RUN_CMD() { printf 'cd %q && CREW_MODEL=%q RELAY_PROJECT=%q node %q %q %q' "$DIR" "$MODEL" "$PROJ" "$BUS_DIR/bin/crew-runner.mjs" "$AGENT" "$DIR"; }

# ── tmux spawn: ONE session `trantor:$PROJ`, one named pane per seat, one Terminal window attached ────
spawn_tmux() {   # $@ = specs
  local first=1 SPEC
  # a pre-existing session for THIS project = the crew is already up; add missing seats as new panes.
  tmux has-session -t "$TMUX_SESS" 2>/dev/null && first=0
  for SPEC in "$@"; do
    resolve_spec "$SPEC"
    local cmd; cmd="$(RUN_CMD)"
    local pane=""
    if [ "$first" = "1" ]; then
      run "tmux new-session -d -s '$TMUX_SESS' -n crew -x 260 -y 60"
      run "tmux send-keys -t '$TMUX_SESS' $(printf '%q' "$cmd") Enter"
      pane="$( [ "$DRY" = "1" ] && echo "%DRY" || tmux display-message -p -t "$TMUX_SESS" '#{pane_id}' 2>/dev/null)"
      first=0
    else
      run "tmux split-window -t '$TMUX_SESS' $(printf '%q' "$cmd")"
      run "tmux select-layout -t '$TMUX_SESS' tiled >/dev/null 2>&1"
      pane="$( [ "$DRY" = "1" ] && echo "%DRY" || tmux display-message -p -t "$TMUX_SESS" '#{pane_id}' 2>/dev/null)"
    fi
    run "tmux select-pane -t '${pane:-$TMUX_SESS}' -T $(printf '%q' "$(echo "$AGENT" | tr '[:lower:]' '[:upper:]')")"
    record_state "$PROJ" "tmux" "$AGENT" "${pane:-%?}"
    echo "  → $AGENT pane in $TMUX_SESS"
  done
  # pane borders show the seat name; attach ONE Terminal window titled with the project
  run "tmux set-option -t '$TMUX_SESS' pane-border-status top >/dev/null 2>&1"
  run "tmux set-option -t '$TMUX_SESS' pane-border-format ' #{pane_title} ' >/dev/null 2>&1"
  if [ "$DRY" = "1" ]; then echo "[dry] would attach a Terminal window to $TMUX_SESS"; record_state "$PROJ" "attach" "__win__" "%DRYWIN"; return 0; fi
  local attach_wid
  attach_wid="$(osascript \
    -e 'tell application "Terminal"' \
    -e "  set w to do script \"tmux attach -t $TMUX_SESS\"" \
    -e "  set custom title of w to \"$PROJ — trantor crew\"" \
    -e "  set theWin to first window whose tabs contains w" \
    -e "  return id of theWin" \
    -e 'end tell' 2>/dev/null)"
  [ -n "$attach_wid" ] && record_state "$PROJ" "attach" "__win__" "$attach_wid"
  echo "— crew grouped in tmux session $TMUX_SESS (one window: $PROJ — trantor crew). Detach with Ctrl-b d; it keeps running. —"
}

# ── Terminal-grid fallback (no tmux): per-agent windows, titled `<PROJECT> · <AGENT>` so sessions differ ──
# Geometry: auto-detected right 58% of the FOCUSED screen.
compute_rect() {
  if [ -n "${CREW_RECT:-}" ]; then IFS=',' read -r GX GY GW GH <<< "$CREW_RECT"; return; fi
  eval "$(osascript -l JavaScript -e '
    ObjC.import("AppKit");
    const f=$.NSScreen.mainScreen.visibleFrame, prim=$.NSScreen.screens.objectAtIndex(0).frame;
    const yTop = prim.size.height - (f.origin.y + f.size.height);
    `SX=${Math.round(f.origin.x)} SY=${Math.round(yTop)} SW=${Math.round(f.size.width)} SH=${Math.round(f.size.height)}`' 2>/dev/null)"
  if [ -z "${SW:-}" ]; then read -r SX SY SW SH <<< "$(osascript -e 'tell application "Finder" to get bounds of window of desktop' | tr ',' ' ')"; SY=25; SH=$(( SH - 25 )); fi
  GX=$(( SX + SW * 42 / 100 )); GY=$SY; GW=$(( SW * 58 / 100 )); GH=$SH
}
spawn_grid() {   # $@ = specs
  compute_rect
  local N=$# COLS=2; [ $N -le 2 ] && COLS=1
  local ROWS=$(( (N + COLS - 1) / COLS ))
  local CW=$(( GW / COLS )) CH=$(( GH / ROWS )) i=0 SPEC
  for SPEC in "$@"; do
    resolve_spec "$SPEC"
    local cmd; cmd="$(RUN_CMD)"
    local C=$(( i % COLS )) R=$(( i / COLS )) X1 Y1 WID=""
    X1=$(( GX + C * CW )); Y1=$(( GY + R * CH ))
    if [ "$DRY" = "1" ]; then echo "[dry] Terminal window for $AGENT at $X1,$Y1"; record_state "$PROJ" "win" "$AGENT" "%DRYWIN$i"; i=$(( i + 1 )); continue; fi
    WID="$(osascript \
      -e 'tell application "Terminal"' \
      -e "  set w to do script \"clear && $cmd\"" \
      -e "  set custom title of w to \"$PROJ · $(echo "$AGENT" | tr '[:lower:]' '[:upper:]')\"" \
      -e "  set theWin to first window whose tabs contains w" \
      -e "  set bounds of theWin to {$X1, $Y1, $(( X1 + CW )), $(( Y1 + CH ))}" \
      -e "  return id of theWin" \
      -e 'end tell' 2>/dev/null)"
    if [ -n "$WID" ]; then record_state "$PROJ" "win" "$AGENT" "$WID"; echo "  → $AGENT window spawned ($PROJ · $AGENT)"; else echo "  ✗ $AGENT osascript spawn ERROR"; fi
    sleep 1.2
    i=$(( i + 1 ))
  done
}
# ── cmux spawn: ONE workspace TAB per project, seats tiled inside it ──────────────────────────────────
# PRIMARY = the control socket (structured, stable UUIDs, native sidebar status) when it's authorized
# (automation.socketControlMode = allowAll). new-workspace launches seat 1; new-split + send add each
# further seat; rename-workspace titles the sidebar tab; the runner pushes per-seat status. Whole-project
# teardown = close-workspace by UUID. FALLBACK = AppleScript (Apple Events, no allowAll needed) when the
# socket is off. Each seat's command rides a launcher script (OSC pane title + no CLI-escaping headaches).
_cmux_surf_json() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.stdout.write(j.surface_id||j.surface_ref||"")}catch(e){}})'; }
spawn_cmux() {   # $@ = specs
  if ! _cmux_ok; then
    echo "— cmux control socket is OFF (mode cmuxOnly) → using AppleScript (works; no native sidebar status)."
    echo "  Enable the full integration: add \"automation\": { \"socketControlMode\": \"allowAll\" } to"
    echo "  ~/.config/cmux/cmux.json (cmux auto-reloads). —"
    spawn_cmux_applescript "$@"; return
  fi
  # Grid tiling: COLS = ceil(sqrt(N)) → 2 seats side-by-side, 4 = 2×2, 6 = 3×2. Row 0 is built with
  # RIGHT splits off the previous column; each later row splits DOWN from the pane directly above it.
  # Every split TARGETS a recorded surface id (--surface) — never "whatever pane happens to be focused",
  # which is what produced the old staircase layout.
  local N=$# COLS=1; while [ $(( COLS * COLS )) -lt "$N" ]; do COLS=$(( COLS + 1 )); done
  local SPEC wsid="" surf="" i=0
  local surfs=()
  for SPEC in "$@"; do
    resolve_spec "$SPEC"
    local cmd launcher; cmd="$(RUN_CMD)"; launcher="$(_seat_launcher "$AGENT" "$cmd")"
    if [ "$i" = "0" ]; then
      if [ "$DRY" = "1" ]; then
        echo "[dry] cmux: new-workspace (cwd $DIR) --command 'bash $launcher' → rename 'trantor:$PROJ'"
        wsid="%DRYWS"; surf="%DRYT0"
      else
        local out ref; out="$(_cmux new-workspace --cwd "$DIR" --command "bash $launcher" 2>&1)"
        ref="$(printf '%s' "$out" | awk '{print $2}')"; wsid="$(_cmux_ws_uuid "$ref")"
        [ -n "$wsid" ] && _cmux rename-workspace --workspace "$wsid" "trantor:$PROJ" >/dev/null 2>&1
        surf="$(_cmux list-pane-surfaces --workspace "$wsid" --id-format uuids --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const o=JSON.parse(d.slice(d.search(/[\[{]/)));const a=o.surfaces||o.panes||o||[];const s=Array.isArray(a)?a[0]:null;process.stdout.write((s&&(s.id||s.surface_id))||"")}catch(e){}})')"
      fi
      record_state "$PROJ" "cmuxws" "__ws__" "$wsid"
    else
      local dir target
      if [ $(( i / COLS )) = "0" ]; then dir="right"; target="${surfs[$(( i - 1 ))]}"
      else dir="down"; target="${surfs[$(( i - COLS ))]}"; fi
      if [ "$DRY" = "1" ]; then
        echo "[dry] cmux: new-split $dir --surface ${target:-<focused>} + send 'bash $launcher'"; surf="%DRYT$i"
      else
        local tflag=(); [ -n "$target" ] && [ "${target#\%DRY}" = "$target" ] && tflag=(--surface "$target")
        surf="$(_cmux new-split "$dir" --workspace "$wsid" "${tflag[@]}" --id-format uuids --json 2>/dev/null | _cmux_surf_json)"
        [ -n "$surf" ] && { _cmux send --surface "$surf" "bash $launcher" >/dev/null 2>&1; _cmux send-key --surface "$surf" enter >/dev/null 2>&1; }
      fi
    fi
    surfs+=("$surf")
    record_state "$PROJ" "cmux" "$AGENT" "$surf"
    echo "  → $AGENT seat in cmux workspace ($PROJ)"
    i=$(( i + 1 ))
  done
  [ "$DRY" = "1" ] || [ -z "$wsid" ] || _cmux set-status trantor "crew up" --icon rocket --color "#14b8a6" --workspace "$wsid" >/dev/null 2>&1
  echo "— crew grouped in cmux: ONE workspace tab for $PROJ, seats tiled + sidebar status. Teardown (this project only): trantor down —"
}

# AppleScript fallback (cmux control socket off): same one-tab-per-project layout, minus native sidebar status.
spawn_cmux_applescript() {   # $@ = specs
  # Same grid math as spawn_cmux: COLS = ceil(sqrt(N)); row 0 splits RIGHT off the previous column,
  # later rows split DOWN from the terminal directly above — targeted by stable terminal id.
  local N=$# COLS=1; while [ $(( COLS * COLS )) -lt "$N" ]; do COLS=$(( COLS + 1 )); done
  local SPEC tabid="" termid="" i=0
  local terms=()
  for SPEC in "$@"; do
    resolve_spec "$SPEC"
    local cmd launcher; cmd="$(RUN_CMD)"; launcher="$(_seat_launcher "$AGENT" "$cmd")"
    if [ "$i" = "0" ]; then
      if [ "$DRY" = "1" ]; then
        echo "[dry] cmux(AppleScript): new tab (trantor:$PROJ) + run 'bash $launcher'"; tabid="%DRYTAB"; termid="%DRYT0"
      else
        local out; out="$(osascript 2>/dev/null <<OSA
tell application "cmux"
  activate
  if (count of windows) is 0 then
    new window
    delay 0.5
  end if
  set t to (new tab)
  delay 0.4
  set term1 to (focused terminal of t)
  input text ("bash $launcher" & return) to term1
  return (id of t) & "|" & (id of term1)
end tell
OSA
)"
        tabid="${out%%|*}"; termid="${out##*|}"
      fi
      record_state "$PROJ" "cmuxws" "__ws__" "$tabid"
    else
      local dir target
      if [ $(( i / COLS )) = "0" ]; then dir="right"; target="${terms[$(( i - 1 ))]}"
      else dir="down"; target="${terms[$(( i - COLS ))]}"; fi
      if [ "$DRY" = "1" ]; then
        echo "[dry] cmux(AppleScript): split $dir from ${target:-<focused>} + run 'bash $launcher'"; termid="%DRYT$i"
      else
        termid="$(osascript 2>/dev/null <<OSA
tell application "cmux"
  set theTab to missing value
  repeat with w in windows
    repeat with tt in tabs of w
      if (id of tt) is "$tabid" then set theTab to tt
    end repeat
  end repeat
  if theTab is missing value then return "ERR"
  set srcTerm to missing value
  repeat with tm in terminals of theTab
    if (id of tm) is "$target" then set srcTerm to tm
  end repeat
  if srcTerm is missing value then set srcTerm to (focused terminal of theTab)
  set newterm to (split srcTerm direction $dir)
  delay 0.25
  input text ("bash $launcher" & return) to newterm
  return (id of newterm)
end tell
OSA
)"
      fi
    fi
    terms+=("$termid")
    record_state "$PROJ" "cmux" "$AGENT" "$termid"
    echo "  → $AGENT seat in cmux workspace ($PROJ)"
    i=$(( i + 1 ))
  done
  echo "— crew grouped in cmux (AppleScript): ONE workspace tab for $PROJ, seats tiled. Teardown: trantor down —"
}

spawn_crew() {   # dispatch: cmux (preferred) → tmux → Terminal grid
  if [ "$HAVE_CMUX" = "1" ]; then spawn_cmux "$@"
  elif [ "$HAVE_TMUX" = "1" ]; then spawn_tmux "$@"
  else
    echo "— no cmux/tmux → per-agent Terminal windows. For ONE grouped, named window per crew (and"
    echo "  bulletproof scoped teardown), install cmux, or run:  brew install tmux  —"
    spawn_grid "$@"
  fi
}

# ── swap: replace a live seat (e.g. one reported exhausted) with a fresh live-selected one ────────────
swap() {
  local OLD="${1:-}" NEWSPEC="${2:-}"
  [ -n "$OLD" ] && [ -n "$NEWSPEC" ] || { echo "usage: trantor swap <oldAgent> <newAgent[:provider[/model]]> [--task K --difficulty D]"; exit 1; }
  echo "— tearing down old seat '$OLD' in $PROJ —"
  down "$OLD"
  echo "— spawning replacement: $NEWSPEC ($TASK/$DIFF) —"
  local SWAP_EPOCH; SWAP_EPOCH=$(epoch_ms)
  spawn_crew "$NEWSPEC"
  local NEWAGENT="${NEWSPEC%%:*}"
  echo "— verifying replacement on the bus —"
  [ "$DRY" = "1" ] || node "$BUS_DIR/bin/crew-verify.mjs" "$PROJ" "$NEWAGENT" --since "$SWAP_EPOCH" --timeout 30
  echo "— swapped. RESEND the contract to '$NEWAGENT' (it joined fresh with no context). —"
}

if [ "$CMD" = "swap" ]; then swap "$@"; exit 0; fi

# ── up ───────────────────────────────────────────────────────────────────────────────────────────────
prune_dead_state
# ensure the cmux CLI is on PATH (opt-in) so runner-side sidebar-status calls resolve from any shell.
if [ "$DRY" != "1" ] && [ "$HAVE_CMUX" = "1" ] && ! command -v cmux >/dev/null 2>&1; then
  mkdir -p "$HOME/.local/bin"
  ln -sf "/Applications/cmux.app/Contents/Resources/bin/cmux" "$HOME/.local/bin/cmux" 2>/dev/null \
    && echo "— linked cmux CLI → ~/.local/bin/cmux —"
fi
[ "$DRY" = "1" ] || node "$BUS_DIR/bin/connect.mjs" | tail -n +2   # one-time CLI wiring (idempotent)

spec_for_agent() { local want="$1"; shift; local s; for s in "$@"; do [ "${s%%:*}" = "$want" ] && { printf '%s' "$s"; return; }; done; printf '%s' "$want"; }

CREW_UI="Terminal windows"; [ "$HAVE_TMUX" = "1" ] && CREW_UI="tmux"; [ "$HAVE_CMUX" = "1" ] && CREW_UI="cmux"
echo "— bringing up crew for $PROJ ($CREW_UI) —"
SPAWN_EPOCH=$(epoch_ms)
spawn_crew "$@"

if [ "$DRY" = "1" ]; then echo "— dry run: no bus verify —"; exit 0; fi
echo "— verifying on the bus (the spawn is not the truth; the bus is) —"
AGENTS_ONLY=$(for a in "$@"; do printf "%s " "${a%%:*}"; done)
VER=$(node "$BUS_DIR/bin/crew-verify.mjs" "$PROJ" $AGENTS_ONLY --since "$SPAWN_EPOCH" --timeout 30)
echo "$VER"
RETRY=$(echo "$VER" | grep "^FAILED:" | cut -d: -f2 | tr ',' ' ')
if [ -n "${RETRY// }" ]; then
  RETRY_SPECS=""; for a in $RETRY; do RETRY_SPECS="$RETRY_SPECS $(spec_for_agent "$a" "$@")"; done
  echo "— retrying failed spawns:$RETRY_SPECS —"
  RETRY_EPOCH=$(epoch_ms)
  spawn_crew $RETRY_SPECS
  VER2=$(node "$BUS_DIR/bin/crew-verify.mjs" "$PROJ" $RETRY --since "$RETRY_EPOCH" --timeout 30)
  echo "$VER2"
  STILL=$(echo "$VER2" | grep "^FAILED:" | cut -d: -f2)
  if [ -n "$STILL" ]; then
    echo ""; echo "✗✗ CREW INCOMPLETE — these agents are NOT on the bus: $STILL"
    echo "   Do NOT assign them work. Investigate their panes/windows or run: crew.sh up ${STILL//,/ }"
    exit 1
  fi
fi
echo "— crew verified on the bus. Send contracts with relay_send; runners keep agents alive for free. Teardown (this project only): trantor down —"

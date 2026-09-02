#!/bin/bash
# trantor crew launcher v3 — visible, GROUPED, per-project crews that can't silently die and that ONE
# session's teardown can't nuke out from under ANOTHER session's crew.
#
#   bin/crew.sh up codex glm kimi deepseek   # bring up THIS project's crew (tmux panes, or Terminal windows)
#   bin/crew.sh open [<project>]              # host the operator's claude as the `orchestrator · <project>`
#                                             #   pane in herdr (reattaches; never stacks a second one)
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
# Hub binding for every seat, resolved HERE and BAKED into the seat command (RELAY_URL=…), so the
# launcher's environment can never silently rebind a crew. Precedence: CREW_HUB (explicit operator
# override) > the project's config PIN > inherited RELAY_URL (tests, unpinned setups) > config.url
# > default. The pin beating inherited env is the 2026-08-14 lesson: a crew launched from a seat
# that lives on the local hub (kimi-orch) inherited its RELAY_URL and recorded a whole build onto
# a board nobody was looking at.
HUB_URL="${CREW_HUB:-$(CFG="${AGENT_BUS_DIR:-$HOME/.agent-bus}/config.json" HUBPROJ="$PROJ" node -e '
const fs=require("fs");let c={};try{c=JSON.parse(fs.readFileSync(process.env.CFG,"utf8"))}catch{}
const pin=c.hubs&&c.hubs[process.env.HUBPROJ];
console.log(pin||process.env.RELAY_URL||c.url||"http://127.0.0.1:4477");' 2>/dev/null)}"
[ -n "$HUB_URL" ] || HUB_URL="${RELAY_URL:-http://127.0.0.1:4477}"
STATE="$HOME/.agent-bus/crew-windows.txt"
mkdir -p "$HOME/.agent-bus"
TMUX_SESS="trantor:$PROJ"                                  # one tmux session per project
HAVE_TMUX=0; command -v tmux >/dev/null 2>&1 && HAVE_TMUX=1
# cmux (https://cmux — a Ghostty-based multiplexer) is the PREFERRED grouping when installed: one workspace
# TAB per project, seats tiled inside it, scoped teardown via `close tab`. Driven by AppleScript (Apple
# Events) — NOT the control socket — so it needs NO socket password (the socket denies external processes
# by default; AppleScript bypasses that, exactly like we already script Terminal.app).
HAVE_CMUX=0; [ -d "/Applications/cmux.app" ] && HAVE_CMUX=1
# PRESENCE vs PREFERENCE: HAVE_* answer "which mux do NEW crews get" and are stomped by CREW_MUX and
# the herdr auto-preference below. *_PRESENT answer "is this mux on the machine at all" and are what
# PRUNE keys on — a row is validated by ITS OWN kind's liveness, never by which mux new crews prefer.
# Conflating them let a dead cmux row survive prune the moment herdr became the preferred default.
CMUX_PRESENT=$HAVE_CMUX
HERDR_PRESENT=0; command -v herdr >/dev/null 2>&1 && HERDR_PRESENT=1
# herdr (https://herdr.dev — a server-held terminal runtime: panes live in its background server, so a
# crew survives the launcher exiting) is the PREFERRED mux when its binary is installed: it is the
# only backend the desktop app's Workspace pane can render, so an auto-detected herdr means every
# `trantor up` on every project shows up live in the app with no flag. (It was opt-in for exactly one
# wave; the first thing the operator noticed was that other projects' crews stayed invisible.)
# CREW_MUX=cmux|tmux|terminal still forces the old dispatch; CREW_MUX=herdr without the binary stays
# a HARD ERROR, because an explicit ask must never silently fall back.
HAVE_HERDR=0
[ -z "${CREW_MUX:-}" ] && command -v herdr >/dev/null 2>&1 && { HAVE_HERDR=1; HAVE_CMUX=0; HAVE_TMUX=0; }
# explicit override (user preference or tests): CREW_MUX=cmux|tmux|terminal|herdr forces the grouping UI.
case "${CREW_MUX:-}" in
  cmux)     HAVE_CMUX=1; HAVE_TMUX=0 ;;
  tmux)     HAVE_CMUX=0; HAVE_TMUX=1 ;;
  terminal) HAVE_CMUX=0; HAVE_TMUX=0 ;;
  herdr)    HAVE_CMUX=0; HAVE_TMUX=0
            command -v herdr >/dev/null 2>&1 || { echo "CREW_MUX=herdr but herdr is not installed — user-local (no sudo): curl -fsSL https://herdr.dev/install.sh | sh — see https://herdr.dev"; exit 1; }
            HAVE_HERDR=1 ;;
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
  if [ "$CMUX_PRESENT" = "1" ] && _cmux ping >/dev/null 2>&1; then _CMUX_OK=1; return 0; fi
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

# ── herdr helpers (active ONLY under the explicit CREW_MUX=herdr opt-in) ────────────────────────────
# herdr's creation commands print JSON ids — capture them, never predict (herdr.dev/docs). All parsing
# tolerates a bare array or a .result wrapper, and a failed/empty parse yields "" (the caller records
# the empty handle and crew-verify flags the dead seat on the bus — the spawn is not the truth).
_herdr() { herdr "$@"; }
_herdr_ws_create() {   # $1=cwd $2=label → "workspace_id<TAB>root_pane_id"
  _herdr workspace create --cwd "$1" --label "$2" --no-focus 2>/dev/null | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const r=(JSON.parse(d.slice(d.search(/[\[{]/))).result)||{};
process.stdout.write((((r.workspace||{}).workspace_id)||"")+"\t"+(((r.root_pane||{}).pane_id)||""))}catch(e){}})'
}
_herdr_split() {   # $1=pane id ("" = UI-focused pane)  $2=right|down → new pane id
  local a=(pane split); [ -n "$1" ] && a+=("$1"); a+=(--direction "$2" --no-focus)
  _herdr "${a[@]}" 2>/dev/null | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const r=(JSON.parse(d.slice(d.search(/[\[{]/))).result)||{};
process.stdout.write(((r.pane||{}).pane_id)||"")}catch(e){}})'
}
_herdr_ws_live() {   # workspace list → "ids<TABnewline>names" (names \x01-wrapped+joined, like cmux)
  _herdr workspace list 2>/dev/null | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const o=JSON.parse(d.slice(d.search(/[\[{]/)));
const a=Array.isArray(o)?o:(o.workspaces||((o.result||{}).workspaces)||[]);
console.log(a.map(x=>x.workspace_id||x.id||"").filter(Boolean).join(" "));
console.log("\u0001"+a.map(x=>x.label||x.name||x.custom_title||"").filter(Boolean).join("\u0001")+"\u0001")}catch(e){}})'
}
# Teardown works regardless of CREW_MUX: you must never need to remember the flag to tear a crew down.
_herdr_close_ws()   { [ "$DRY" = "1" ] && { echo "[dry] herdr workspace close $1"; return 0; }; _herdr workspace close "$1" >/dev/null 2>&1; }
_herdr_close_pane() { [ "$DRY" = "1" ] && { echo "[dry] herdr pane close $1";    return 0; }; _herdr pane close    "$1" >/dev/null 2>&1; }
# Tell herdr a pane hosts an agent. WITHOUT this the pane is just a shell to herdr, `herdr agent
# attach` answers agent_not_found, and the app's terminal shows that error instead of the seat —
# observed 2026-08-27 on every seat while the orchestrator (claude, which herdr detects on its own)
# streamed fine. NOTE the argument order: the pane id must come FIRST, before the flags.
# ── orchestrator continuity ────────────────────────────────────────────────────────────────────
# herdr keeps the PANE alive across an app quit, and launchd keeps its server alive across a
# reboot. Neither preserves the CONVERSATION: a pty that dies comes back empty, because the
# transcript was never a property of the terminal. That part is ours.
#
# So the project gets ONE claude session id, chosen by us and remembered. First open starts claude
# under it; every later open resumes it. Discovering the id afterwards would be guesswork, and
# `--continue` would grab whatever ran last in this directory, which may be a different window.
# A NAMED project must open in ITS checkout, wherever the caller stands (2026-08-31: the app ran
# `trantor open crebral-health` from the Tauri process cwd and claude booted THERE — a trust
# prompt for a folder the operator never chose, transcripts under the wrong slug, no project
# memory, ACTIVE NOW blind). Resolution mirrors the app's project_dir: $TRANTOR_DEV_ROOT
# (default ~/development)/<name>. Unknown name from an unrelated cwd → refuse loudly rather
# than open somewhere silly.
_orch_resolve_dir() {   # $1=cwd $2=project-arg → dir to open in (stdout); fails when unresolvable
  local herebase; herebase="$(basename "$(git -C "$1" rev-parse --show-toplevel 2>/dev/null || echo "$1")")"
  if [ -z "$2" ] || [ "$2" = "$herebase" ]; then printf '%s' "$1"; return 0; fi
  local devroot="${TRANTOR_DEV_ROOT:-$HOME/development}"
  if [ -d "$devroot/$2" ]; then
    echo "— opening $2 in its checkout: $devroot/$2 —" >&2
    printf '%s' "$devroot/$2"; return 0
  fi
  echo "trantor open: '$2' has no checkout at $devroot/$2 and this is '$herebase' — cd into the project first" >&2
  return 1
}

_orch_sid() {   # $1=project → the project's session uuid, minting one on first use
  local f="${STATE%/*}/orch-sessions.txt" p sid
  if [ -f "$f" ]; then
    while IFS="$(printf '\t')" read -r p sid; do
      [ "$p" = "$1" ] && [ -n "$sid" ] && { printf '%s' "$sid"; return 0; }
    done < "$f"
  fi
  sid="$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z')"
  [ -n "$sid" ] || return 1
  [ "$DRY" = "1" ] || { mkdir -p "${f%/*}"; printf '%s\t%s\n' "$1" "$sid" >> "$f"; }
  printf '%s' "$sid"
}

# claude writes each conversation to ~/.claude/projects/<slug>/<session-id>.jsonl, where the slug
# is the working directory with every / and . turned into -.
_orch_transcript() { printf '%s' "$HOME/.claude/projects/$(printf '%s' "$1" | tr '/.' '--')/$2.jsonl"; }

# A herdr server started from inside a Claude Code session hands its whole environment to every
# pane it later spawns, and those markers are session-scoped, not machine-scoped. The damage is
# quiet and total: claude sees CLAUDE_CODE_CHILD_SESSION, decides it is a sub-session and TURNS
# TRANSCRIPT SAVING OFF — so --resume would have nothing to resume and the persistence above would
# be theatre. CLAUDE_CODE_MESSAGING_SOCKET/TOKEN are worse: they point the new session at the
# ORIGINATING session's socket, which is how a fresh pane ends up claiming another session's baton.
#
# Feature flags the operator actually set (AGENT_TEAMS, FORK_SUBAGENT, EFFORT) are deliberately
# left alone. Only identity is stripped.
ORCH_STRIP="CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_BRIDGE_SESSION_ID CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_CODE_EXECPATH CLAUDE_PID"
# TRANTOR_ORCH marks the pane's claude as THE orchestrator pane for $PROJ: the sessionstart hook
# uses it to claim a held orchestrator baton immediately and to record its own session id in
# orch-sessions.txt (project-matched on the hook side, so a child claude elsewhere can't inherit it).
_orch_env() { local v out="env"; for v in $ORCH_STRIP; do out="$out -u $v"; done; printf '%s TRANTOR_ORCH=%s' "$out" "$PROJ"; }

# The HARNESS dial (trantor autonomy). "bypass" is what the operator means by letting the agent
# just work; "prompt" is the default because a fresh install must never silently skip a permission
# the operator has not chosen to skip. Read per open, so changing it in the app takes effect the
# next time the session is started rather than needing a reinstall.
_orch_flags() {
  local mode
  mode="$(node "$(dirname "$0")/autonomy.mjs" get harness --project "$PROJ" 2>/dev/null)"
  [ "$mode" = "bypass" ] && printf ' --dangerously-skip-permissions'
}

# Resume when the conversation already exists on disk; otherwise start it under the id we picked so
# the NEXT open can resume it.
_orch_cmd() {   # $1=dir $2=sid
  if [ -f "$(_orch_transcript "$1" "$2")" ]; then printf '%s claude%s --resume %s' "$(_orch_env)" "$(_orch_flags)" "$2"
  else printf '%s claude%s --session-id %s' "$(_orch_env)" "$(_orch_flags)" "$2"; fi
}

# A recorded thread that HANDED OFF has ended: resuming it replays a dead conversation while the
# handoff waits for a successor (the 2026-08-27 seam — "Trantor resumes the wrong thread").
# ANY unconsumed handoff for the project means a successor is OWED a fresh window — open must
# start a FRESH id so the sessionstart hook claims the baton (it then records the fresh id in
# orch-sessions.txt; single writer: the hook + adopt — this function writes nothing).
# The old predicate required the handoff to be written BY the recorded session (session_id match)
# — but MANUAL handoffs carry no session_id at all, so on 2026-08-31 the reboot flow resumed the
# same maxed-out conversation TWICE while its handoff sat unclaimed, and the injected recap
# banner made each resume LOOK like a clean takeover. Who wrote it doesn't matter; that it is
# unclaimed does.
_orch_takeover_sid() {   # $1=project $2=recorded-sid → prints the sid open should use
  local fresh
  if node -e '
const fs=require("fs"),path=require("path"),os=require("os");
const dir=path.join(process.env.AGENT_BUS_DIR||process.env.RELAY_DATA_DIR||path.join(os.homedir(),".agent-bus"),"handoffs");
const [proj]=process.argv.slice(1);
try{
  const re=new RegExp("^"+proj.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"-(\\d+)\\.json$");
  const files=fs.readdirSync(dir).map(f=>{const m=re.exec(f);return m?{f,s:Number(m[1])}:null}).filter(Boolean).sort((a,b)=>b.s-a.s);
  for(const {f} of files){
    const r=JSON.parse(fs.readFileSync(path.join(dir,f),"utf8"));
    if(r.consumed) continue;
    process.exit(0);   // newest UNCONSUMED exists → a successor is owed a fresh window
  }
}catch(e){}
process.exit(1);' "$1" 2>/dev/null; then
    fresh="$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z')"
    [ -n "$fresh" ] && { echo "— recorded session $2 handed off: starting fresh as $fresh to claim it —" >&2; printf '%s' "$fresh"; return 0; }
  fi
  printf '%s' "$2"
}

# Does herdr see a LIVE agent in this pane? A pane answering `rename` only proves the pane exists;
# the process inside it can be long gone, and reattaching to a dead shell shows the operator an
# empty terminal that never fills.
_herdr_pane_has_agent() { _herdr agent list 2>/dev/null | grep -q "\"pane_id\":\"$1\""; }

_herdr_report_agent() {   # $1=pane $2=agent-label
  [ "$DRY" = "1" ] && { echo "[dry] herdr pane report-agent $1 --source crew --agent $2 --state working"; return 0; }
  _herdr pane report-agent "$1" --source crew --agent "$2" --state working >/dev/null 2>&1
}

# ── herdr spawn: ONE workspace `trantor:$PROJ`, one named pane per seat ─────────────────────────────
# Topology = workspace create (its root pane runs seat 1) + pane split for the rest, same ceil(√N) grid
# doctrine as cmux; pane rename labels each seat; pane run submits the seat command (bracketed-paste
# safe, sends Enter). Same replace-never-stack doctrine: REUSE the newest tracked workspace for this
# project, close older stacked ones, adopt one untracked live trantor:$PROJ workspace.
spawn_herdr() {   # $@ = specs
  local REUSE_WS="" line w
  local stale_ws=()
  if [ -f "$STATE" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      _parse_row "$line"
      { [ "$RP" = "$PROJ" ] && [ "$RK" = "herdrws" ]; } || continue
      [ -n "$REUSE_WS" ] && stale_ws+=("$REUSE_WS")
      REUSE_WS="$RH"
    done < "$STATE"
  fi
  if [ "${#stale_ws[@]}" -gt 0 ]; then
    for w in "${stale_ws[@]}"; do
      echo "  → closing stale stacked crew workspace for $PROJ ($w)"
      _herdr_close_ws "$w"; _state_drop "$PROJ" "herdrws" "" "$w"
    done
    prune_dead_state    # the closed workspaces' seat rows just died with them
  fi
  # Untracked strays: LIVE workspaces labeled trantor:$proj that STATE doesn't know. Adopt one as the
  # reuse target if we have none; close the rest. (Skipped in DRY: read-only drills seed STATE instead.)
  if [ "$DRY" != "1" ]; then
    local named nid
    named="$(_herdr workspace list 2>/dev/null | WSNAME="trantor:$PROJ" node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const o=JSON.parse(d.slice(d.search(/[\[{]/)));const a=Array.isArray(o)?o:(o.workspaces||((o.result||{}).workspaces)||[]);console.log(a.filter(x=>x.label===process.env.WSNAME||x.name===process.env.WSNAME||x.custom_title===process.env.WSNAME).map(x=>x.workspace_id||x.id||"").filter(Boolean).join(" "))}catch(e){}})')"
    for nid in $named; do
      [ "$nid" = "$REUSE_WS" ] && continue
      [ -f "$STATE" ] && grep -qF "$nid" "$STATE" && continue     # tracked → handled above
      if [ -z "$REUSE_WS" ]; then
        echo "  → adopting existing untracked crew workspace for $PROJ ($nid)"
        REUSE_WS="$nid"; record_state "$PROJ" "herdrws" "__ws__" "$nid"
      else
        echo "  → closing stray crew workspace for $PROJ ($nid)"
        _herdr_close_ws "$nid"
      fi
    done
  fi
  # Grid tiling (identical math to cmux): row 0 splits RIGHT off the previous column, later rows split
  # DOWN from the pane directly above. In REUSE mode a replaced seat splits off its OWN old pane —
  # keeping its spot — and added seats split right off the previous new pane.
  local N=$# COLS=1; while [ $(( COLS * COLS )) -lt "$N" ]; do COLS=$(( COLS + 1 )); done
  local SPEC wsid="" surf i=0
  local surfs=()
  [ -n "$REUSE_WS" ] && wsid="$REUSE_WS"
  for SPEC in "$@"; do
    resolve_spec "$SPEC" || continue
    local cmd; cmd="$(RUN_CMD)"
    if [ -n "$REUSE_WS" ]; then
      # replace-in-place: split the fresh pane FIRST (targeting the agent's old pane when tracked),
      # then close the old pane — split-first so the workspace never dips to zero panes mid-swap.
      local OLD_SURF=""
      if [ -f "$STATE" ]; then
        while IFS= read -r line; do
          [ -n "$line" ] || continue
          _parse_row "$line"
          [ "$RP" = "$PROJ" ] && [ "$RK" = "herdr" ] && [ "$RA" = "$AGENT" ] && OLD_SURF="$RH"
        done < "$STATE"
      fi
      local t=""
      [ -n "$OLD_SURF" ] && t="$OLD_SURF"
      { [ -z "$t" ] && [ "$i" -gt 0 ]; } && t="${surfs[$(( i - 1 ))]}"
      if [ "$DRY" = "1" ]; then
        echo "[dry] herdr: reuse workspace $wsid — pane split for $AGENT${OLD_SURF:+ (replacing $OLD_SURF)}"
        surf="%DRYT$i"
        [ -n "$OLD_SURF" ] && _herdr_close_pane "$OLD_SURF"
      else
        surf="$(_herdr_split "$t" right)"
        [ -n "$surf" ] && { _herdr pane rename "$surf" "$AGENT · $PROJ" >/dev/null 2>&1; _herdr pane run "$surf" "$cmd" >/dev/null 2>&1; }
        if [ -n "$OLD_SURF" ]; then _herdr_close_pane "$OLD_SURF"; _state_drop "$PROJ" "herdr" "$AGENT" ""; fi
      fi
    elif [ "$i" = "0" ]; then
      if [ "$DRY" = "1" ]; then
        echo "[dry] herdr: workspace create (cwd $DIR) --label 'trantor:$PROJ' → root pane + run '$cmd'"
        wsid="%DRYWS"; surf="%DRYT0"
      else
        local pair; pair="$(_herdr_ws_create "$DIR" "trantor:$PROJ")"
        wsid="${pair%%$'\t'*}"; surf="${pair##*$'\t'}"
        [ -n "$surf" ] && { _herdr pane rename "$surf" "$AGENT · $PROJ" >/dev/null 2>&1; _herdr pane run "$surf" "$cmd" >/dev/null 2>&1; }
      fi
      record_state "$PROJ" "herdrws" "__ws__" "$wsid"
    else
      local dir target
      if [ $(( i / COLS )) = "0" ]; then dir="right"; target="${surfs[$(( i - 1 ))]}"
      else dir="down"; target="${surfs[$(( i - COLS ))]}"; fi
      if [ "$DRY" = "1" ]; then
        echo "[dry] herdr: pane split ${target:-<focused>} --direction $dir + run '$cmd'"
        surf="%DRYT$i"
      else
        surf="$(_herdr_split "$target" "$dir")"
        [ -n "$surf" ] && { _herdr pane rename "$surf" "$AGENT · $PROJ" >/dev/null 2>&1; _herdr pane run "$surf" "$cmd" >/dev/null 2>&1; }
      fi
    fi
    # Every path, dry included: herdr must know this pane hosts an agent or `agent attach` — which
    # is how the app streams it — answers agent_not_found and the seat renders as an error.
    [ -n "$surf" ] && _herdr_report_agent "$surf" "$AGENT"
    surfs+=("$surf")
    record_state "$PROJ" "herdr" "$AGENT" "$surf"
    echo "  → $AGENT seat in herdr workspace ($PROJ)"
    i=$(( i + 1 ))
  done
  echo "— crew grouped in herdr: ONE workspace for $PROJ, seats as named panes in its server. Teardown (this project only): trantor down —"
}

# surgical STATE row removal: drop every row matching PROJECT+KIND (+AGENT/+HANDLE when given).
# Empty $3/$4 = wildcard. Callers beware: uses _parse_row, which clobbers the RP/RK/RA/RH globals.
_state_drop() {   # $1=project $2=kind $3=agent(''=any) $4=handle(''=any)
  [ "$DRY" = "1" ] && return 0
  [ -f "$STATE" ] || return 0
  local tmp="$STATE.tmp" line
  : > "$tmp"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    _parse_row "$line"
    if [ "$RP" = "$1" ] && [ "$RK" = "$2" ] && { [ -z "$3" ] || [ "$RA" = "$3" ]; } && { [ -z "$4" ] || [ "$RH" = "$4" ]; }; then continue; fi
    printf '%s\t%s\t%s\t%s\n' "$RP" "$RK" "$RA" "$RH" >> "$tmp"
  done < "$STATE"
  mv "$tmp" "$STATE"; [ -s "$STATE" ] || rm -f "$STATE"
}

# Belt-and-suspenders on seat teardown: closing the pane/window SHOULD take the runner with it, but a
# STALE handle (the 2026-07-30 duplicate-row incident) closes nothing while teardown thinks it's done —
# the runner survives invisible, still long-polling the inbox. So teardown also kills the seat's
# processes directly: the per-seat launcher shell, and the runner via the same ANCHORED pattern
# doctrine as reap_seat (…/<project>$ — a sibling project can never match). CREW_NO_PROC_KILL=1 is the
# test-suite escape hatch: the suite seeds real project names, and a live crew must survive `npm test`.
_kill_seat_procs() {   # $1=project $2=agent
  [ "${CREW_NO_PROC_KILL:-0}" = "1" ] && return 0
  [ -n "$1" ] && [ -n "$2" ] || return 0
  local pid
  for pid in $(pgrep -f "seats/$1-$2\.sh" 2>/dev/null); do run "kill -9 $pid 2>/dev/null"; done
  for pid in $(pgrep -f "crew-runner\.mjs $2 .*/$1"'$' 2>/dev/null); do run "kill -9 $pid 2>/dev/null"; done
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
  local scoped=() line killlist="" seentmux="" orch_scopes=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    _parse_row "$line"                                       # → RP RK RA RH
    # scope: --all → every row; else → ONLY this project's rows. Legacy (project-less, pre-v3) rows are
    # SKIPPED by a scoped down — we can't prove they're ours, and killing another project's crew is the exact
    # bug we're fixing. `trantor down --all` reaches them; otherwise they self-heal via prune_dead_state.
    if [ "$WANT_ALL" != "1" ] && [ "$RP" != "$PROJ" ]; then continue; fi
    # a project hosting the orchestrator pane degrades to PER-SEAT teardown: its workspace must survive
    # (the orch pane lives inside it — closing the workspace closes the terminal the operator is typing
    # in, from inside that terminal), so only the seat panes are closed.
    [ "$RK" = "orch" ] && case ";$orch_scopes;" in *";$RP;"*) : ;; *) orch_scopes="$orch_scopes;$RP;" ;; esac
    if [ "${#AGENTS[@]}" -gt 0 ]; then                       # agent filter (if specific seats named)
      local match=0 want; for want in "${AGENTS[@]}"; do [ "$RA" = "$want" ] && match=1; done
      [ "$match" = "1" ] || continue
    fi
    scoped+=("$RP|$RK|$RA|$RH")
    case "$RK" in attach|cmuxws|herdrws|orch) continue ;; esac # infra rows (attach/cmux/herdr workspace/orch) — not seats; `orch` is SPARED entirely
    killlist="$killlist  • ${RP:-<legacy>} · $RA ($RK)"$'\n'
  done < "$STATE"
  _has_orch() { case "$orch_scopes" in *";$1;"*) return 0 ;; esac; return 1; }

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
      cmuxws) { [ "${#AGENTS[@]}" -gt 0 ] || _has_orch "$P2"; } || _cmux_close_tab "$H2" ;;   # whole workspace (unless seats are named or an orch pane lives in it)
      cmux)   { [ "${#AGENTS[@]}" -gt 0 ] || _has_orch "$P2"; } && _cmux_close_term "$H2" ;;  # a single seat's pane
      herdrws) { [ "${#AGENTS[@]}" -gt 0 ] || _has_orch "$P2"; } || _herdr_close_ws "$H2" ;;  # whole workspace (unless seats are named or an orch pane lives in it)
      herdr)   { [ "${#AGENTS[@]}" -gt 0 ] || _has_orch "$P2"; } && _herdr_close_pane "$H2" ;;# a single seat's pane
      tmux)
        if [ "${#AGENTS[@]}" -gt 0 ]; then run "tmux kill-pane -t '$H2' 2>/dev/null"      # per-seat
        else
          local sess="trantor:$P2"
          case " $seentmux " in *" $sess "*) : ;; *) run "tmux kill-session -t '$sess' 2>/dev/null"; seentmux="$seentmux $sess" ;; esac
        fi ;;
      win|attach) { [ "${#AGENTS[@]}" -gt 0 ] && [ "$K2" = "attach" ]; } && continue; _kill_win "$H2" ;;
    esac
    case "$K2" in cmuxws|attach|herdrws) : ;; *) _kill_seat_procs "$P2" "$A2" ;; esac
  done

  # rewrite STATE minus the rows we tore down (leaves OTHER projects' rows intact). An orch-hosting
  # project's workspace rows survive too — the workspace is still needed by the spared orch pane.
  if [ "$DRY" != "1" ]; then
    local tmp="$STATE.tmp"; : > "$tmp"
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      _parse_row "$line"
      local drop=0
      for s in "${scoped[@]}"; do [ "$s" = "$RP|$RK|$RA|$RH" ] && drop=1; done
      # `orch` itself is spared alongside the workspace that hosts it: down never closes the
      # orchestrator pane, so dropping its row would orphan a live pane and let the next `open`
      # stack a second orchestrator on top of it.
      [ "$drop" = "1" ] && _has_orch "$RP" && case "$RK" in herdrws|cmuxws|orch) drop=0 ;; esac
      [ "$drop" = "1" ] || printf '%s\t%s\t%s\t%s\n' "$RP" "$RK" "$RA" "$RH" >> "$tmp"
    done < "$STATE"
    mv "$tmp" "$STATE"
    [ -s "$STATE" ] || rm -f "$STATE"
  fi
  echo "— crew torn down ($SCOPE_DESC)"
}
[ "$CMD" = "down" ] && { down "$@"; exit $?; }
case "$CMD" in up|open|swap|prune) ;; *) echo "usage: crew.sh up <agent...> | crew.sh open [<project>] | crew.sh swap <old> <new[:provider[/model]]> | crew.sh down [<agent>...] [--all --yes] | crew.sh prune"; exit 1 ;; esac

# self-heal: drop STATE rows whose Terminal window is already gone (dead crews from past sessions), so the
# file doesn't accumulate ghosts across ups. tmux rows are validated by their session existing; cmux rows
# by the workspace/surface uuid still existing on the control socket. Socket off (or an empty/unparsable
# workspace list) ⇒ cmux rows are KEPT — we can't prove death, and they self-heal next time it answers.
prune_dead_state() {
  [ -f "$STATE" ] || return 0
  [ "$DRY" = "1" ] && return 0
  # CLIVE = live workspace uuids · CLIVE_NAMES = their titles. Seat (`cmux`) rows are validated at
  # WORKSPACE granularity — is a live workspace named trantor:<their project> still up? — NOT per
  # surface: `list-pane-surfaces --workspace` only returns the FIRST pane's surfaces, so a
  # per-surface check reaps every split-created live seat's row (bug shipped 0.17.61, caught
  # 2026-08-07 when it stripped two live crews' seat rows).
  local CLIVE="" CLIVE_NAMES=""
  if _cmux_ok; then
    local pair
    pair="$(_cmux workspace list --id-format both --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const o=JSON.parse(d.slice(d.search(/[\[{]/)));const a=Array.isArray(o)?o:(o.workspaces||[]);console.log(a.map(x=>x.id).filter(Boolean).join(" "));console.log(""+a.map(x=>x.custom_title||x.name||"").filter(Boolean).join("")+"")}catch(e){}})')"
    CLIVE="$(printf '%s' "$pair" | sed -n 1p)"
    CLIVE_NAMES="$(printf '%s' "$pair" | sed -n 2p)"
  fi
  # herdr liveness is queried whenever the BINARY is present (herdr rows deserve validation no
  # matter which mux new crews prefer). Same keep-when-unprovable doctrine as cmux — no answer,
  # or no binary at all ⇒ rows are KEPT.
  local HLIVE="" HLIVE_NAMES=""
  if [ "$HERDR_PRESENT" = "1" ]; then
    local hpair
    hpair="$(_herdr_ws_live)"
    HLIVE="$(printf '%s' "$hpair" | sed -n 1p)"
    HLIVE_NAMES="$(printf '%s' "$hpair" | sed -n 2p)"
  fi
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
    elif [ "$RK" = "cmuxws" ]; then
      if [ -n "$CLIVE" ]; then case " $CLIVE " in *" $RH "*) : ;; *) alive=0 ;; esac; fi
    elif [ "$RK" = "cmux" ]; then
      # seat row lives exactly as long as its project still has a live crew workspace
      if [ -n "$CLIVE" ]; then case "$CLIVE_NAMES" in *$'\x01'"trantor:$RP"$'\x01'*) : ;; *) alive=0 ;; esac; fi
    elif [ "$RK" = "herdrws" ]; then
      if [ -n "$HLIVE" ]; then case " $HLIVE " in *" $RH "*) : ;; *) alive=0 ;; esac; fi
    elif [ "$RK" = "herdr" ] || [ "$RK" = "orch" ]; then
      # seat + orchestrator rows live exactly as long as their project still has a live crew workspace
      # — validated at WORKSPACE granularity, never per pane (the cmux 0.17.61 lesson generalized)
      if [ -n "$HLIVE" ]; then case "$HLIVE_NAMES" in *$'\x01'"trantor:$RP"$'\x01'*) : ;; *) alive=0 ;; esac; fi
    fi
    [ "$alive" = "1" ] && printf '%s\t%s\t%s\t%s\n' "$RP" "$RK" "$RA" "$RH" >> "$tmp"
  done < "$STATE"
  mv "$tmp" "$STATE"; [ -s "$STATE" ] || rm -f "$STATE"
}
# `crew.sh prune` — run the self-heal on demand (ops: clean ghost rows without spawning anything).
[ "$CMD" = "prune" ] && { prune_dead_state; echo "— pruned dead crew rows ($STATE) —"; exit 0; }

# ── open: host the OPERATOR's session as the `orchestrator · <project>` pane (card #5396) ────────────
# The session a developer actually works in used to be an unowned Terminal window — invisible to the
# app, and killed by any whole-project `down` that closed the workspace under it. `trantor open`
# hosts it as a herdr pane in the SAME `trantor:<project>` workspace the crew uses (herdr keeps the
# pane alive server-side; Terminal attaches to the SAME session), and prints the pane TARGET on
# stdout as ONE line:   herdr:<workspace_id>/<pane_id>   (human chatter goes to stderr, so the
# target is capturable). REATTACH, NEVER STACK: a second open finds the tracked `orch` row alive and
# reprints the target — two orchestrator claude processes on one project would fight over one bus
# identity (the duplicated-runner lesson, crew.sh edition). The liveness probe is an idempotent
# rename to the pane's own title: no per-pane list API is trusted (the 0.17.61 workspace-granularity
# lesson), and a closed pane can never pass it. `down` SPARES `orch` rows for the same reason.
usage_open() {
  cat <<EOF
usage: trantor open [<project>]
  host THIS project's orchestrator session as a herdr pane in workspace trantor:<project>
  (creating the workspace if needed) and print its TARGET on stdout. A second open REATTACHES:
  it prints the existing target and exits 0 without spawning a second orchestrator.
EOF
}
open_orchestrator() {
  local a PROJ_ARG=""
  for a in "$@"; do case "$a" in
    --help|-h) usage_open; return 0 ;;
    --*) echo "trantor open: unknown flag '$a'"; usage_open; return 1 ;;
    *) PROJ="$a"; PROJ_ARG="$a" ;;
  esac; done
  # only an EXPLICIT name is resolved to its checkout; a project declared by RELAY_PROJECT from
  # inside a differently named dir (the test harness, RELAY_PROJECT=<name> sessions) means "this
  # cwd IS the project" — refusing it made `trantor open` impossible for exactly those sessions
  DIR="$(_orch_resolve_dir "$DIR" "${PROJ_ARG:-}")" || exit 1
  command -v herdr >/dev/null 2>&1 || { echo "trantor open needs herdr (the pane host) — install: curl -fsSL https://herdr.dev/install.sh | sh"; exit 1; }
  local wsid="" orch="" live_ids="" live_names="" pair="" line fresh=0
  local sid; sid="$(_orch_sid "$PROJ")" || { echo "trantor open: could not mint a session id (uuidgen missing?)" >&2; exit 1; }
  sid="$(_orch_takeover_sid "$PROJ" "$sid")"
  if [ "$DRY" != "1" ]; then
    pair="$(_herdr_ws_live)"
    live_ids="$(printf '%s' "$pair" | sed -n 1p)"
    live_names="$(printf '%s' "$pair" | sed -n 2p)"
  fi
  if [ -f "$STATE" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      _parse_row "$line"
      [ "$RP" = "$PROJ" ] || continue
      case "$RK" in
        herdrws)
          # a tracked workspace is only usable while LIVE (label match); a provably dead row is dropped.
          # No live answer ⇒ kept (the keep-when-unprovable doctrine shared with prune).
          if [ "$DRY" != "1" ] && [ -n "$live_ids" ]; then
            case " $live_ids " in *" $RH "*) wsid="$RH" ;; *) _state_drop "$PROJ" "herdrws" "" "$RH" ;; esac
          else wsid="$RH"; fi ;;
        orch) orch="$RH" ;;
      esac
    done < "$STATE"
  fi
  # REATTACH, never stack: a tracked orch pane that still answers is reused as-is.
  if [ -n "$orch" ]; then
    if [ "$DRY" = "1" ]; then
      echo "herdr:${wsid:-%DRYWS}/$orch"
      return 0
    fi
    if _herdr pane rename "$orch" "orchestrator · $PROJ" >/dev/null 2>&1; then
      if _herdr_pane_has_agent "$orch"; then
        echo "herdr:${wsid:-?}/$orch"
        # CONTRACT: the app's orchestrator_open (desktop terminal.rs) matches this exact phrase
        # to SKIP its kickoff prompt — a reattach is a live conversation, never to be typed into.
        echo "— orchestrator already hosted: reattached to herdr:${wsid:-?}/$orch —" >&2
        return 0
      fi
      # The pane outlived its claude (a crash, or a reboot that took the process but not the row).
      # Restart the CONVERSATION in the same pane rather than handing back an empty terminal.
      _herdr pane run "$orch" "$(_orch_cmd "$DIR" "$sid")" >/dev/null 2>&1
      _herdr_report_agent "$orch" "claude"
      echo "herdr:${wsid:-?}/$orch"
      echo "— orchestrator pane was empty: resumed session $sid in herdr:${wsid:-?}/$orch —" >&2
      return 0
    fi
    _state_drop "$PROJ" "orch" "" ""; orch=""     # stale row → healed by the create path below
  fi
  # No usable workspace yet: adopt an untracked LIVE crew workspace before creating a second one
  # (spawn_herdr's adopt-else-create doctrine — open must not stack trantor:<project> workspaces).
  if [ -z "$wsid" ]; then
    if [ "$DRY" = "1" ]; then
      wsid="%DRYWS"
      echo "[dry] herdr: workspace create (cwd $DIR) --label 'trantor:$PROJ'" >&2
    else
      local found=""
      case "$live_names" in
        *$'\x01'"trantor:$PROJ"$'\x01'*)
          found="$(_herdr workspace list 2>/dev/null | WSNAME="trantor:$PROJ" node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const o=JSON.parse(d.slice(d.search(/[\[{]/)));const a=Array.isArray(o)?o:(o.workspaces||((o.result||{}).workspaces)||[]);console.log(a.filter(x=>x.label===process.env.WSNAME||x.name===process.env.WSNAME||x.custom_title===process.env.WSNAME).map(x=>x.workspace_id||x.id||"").filter(Boolean)[0]||"")}catch(e){}})')"
          [ -n "$found" ] && echo "— adopting existing crew workspace for $PROJ ($found) —" >&2 ;;
      esac
      if [ -n "$found" ]; then wsid="$found"
      else
        pair="$(_herdr_ws_create "$DIR" "trantor:$PROJ")"
        wsid="${pair%%$'\t'*}"; fresh=1
      fi
      [ -n "$wsid" ] || { echo "trantor open: herdr workspace create failed" >&2; exit 1; }
    fi
    record_state "$PROJ" "herdrws" "__ws__" "$wsid"
  fi
  # Host the pane: a JUST-created workspace's root pane IS the orchestrator pane (claude rides it);
  # an existing workspace gets a split — the crew's seats tile off it on the next `up`, never
  # replacing it (spawn_herdr's REUSE mode splits seats off their own old pane / the previous one).
  if [ "$DRY" = "1" ]; then
    orch="%DRYORCH"
    echo "[dry] herdr: ${fresh:+root pane + }pane rename $orch 'orchestrator · $PROJ' + run '$(_orch_cmd "$DIR" "$sid")'" >&2
  else
    if [ "$fresh" = "1" ]; then orch="${pair##*$'\t'}"
    else orch="$(_herdr_split "" right)"; fi
    [ -n "$orch" ] || { echo "trantor open: could not create the orchestrator pane" >&2; exit 1; }
    _herdr pane rename "$orch" "orchestrator · $PROJ" >/dev/null 2>&1
    _herdr pane run "$orch" "$(_orch_cmd "$DIR" "$sid")" >/dev/null 2>&1
    _herdr_report_agent "$orch" "claude"
  fi
  _state_drop "$PROJ" "orch" "" ""                 # replace-never-stack: exactly one orch row per project
  record_state "$PROJ" "orch" "__orch__" "$orch"
  echo "herdr:$wsid/$orch"
  echo "— orchestrator pane hosted: herdr:$wsid/$orch (claude in $DIR). 'trantor down' spares it. —" >&2
  return 0
}
[ "$CMD" = "open" ] && { open_orchestrator "$@"; exit $?; }

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
echo "[crew] hub for $PROJ: $HUB_URL (baked into every seat; CREW_HUB=<url> overrides)"

# scrooge (the model-routing brain) is bundled with this trantor install; fall back to PATH.
SCROOGE="$BUS_DIR/engine/bin/scrooge"
[ -f "$SCROOGE" ] || SCROOGE="$(command -v scrooge 2>/dev/null || echo scrooge)"

# resolve_model <agent> <provider> <task> <diff> -> echoes a provider-qualified model id.
# A provider seat must never fall through to opencode's unrelated global default.
resolve_model() {
  local agent="$1" provider="$2" task="$3" diff="$4" cands="" out=""
  cands="$(opencode models "$provider" 2>/dev/null | tr '\n' ' ')"
  if [ -n "$cands" ]; then
    out="$(python3 "$SCROOGE" route --candidates "$cands" -t "$task" -d "$diff" --json 2>/dev/null)"
  else
    out="$(python3 "$SCROOGE" route --provider "$provider" -t "$task" -d "$diff" --json 2>/dev/null)"
  fi
  if [ -n "$out" ]; then
    out="$(printf '%s' "$out" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("qualified") or "")
except Exception: pass' 2>/dev/null)"
  fi
  # The router can be absent (a fresh machine, a dry run, scrooge without its registry). That must
  # never hand the seat to opencode's GLOBAL default (#6068, the DeepSeek bill) and must not drop
  # the seat either (#6110): fall back INSIDE the provider — the head of its own catalog — and say so.
  if [ -z "$out" ] && [ -n "$cands" ]; then
    out="$provider/${cands%% *}"
    echo "[crew] router unavailable for $agent:$provider — using the provider's own catalog head ($out)" >&2
  fi
  [ -n "$out" ] || { echo "[crew] live model selection failed for $agent:$provider — no router and no catalog; refusing opencode global default" >&2; return 1; }
  [ "${out%%/*}" = "$provider" ] || {
    echo "[crew] router selected $out outside $provider — refusing cross-provider fallback" >&2
    return 1
  }
  printf '%s' "$out"
}

epoch_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

# resolve_spec <spec> -> sets AGENT + MODEL globals (live-selects a provider-only spec).
# On failure, returns 1 (AGENT is still set; MODEL is empty) instead of exiting the whole script —
# callers are responsible for skipping that one seat and continuing the batch. SKIPPED_SEATS
# accumulates "agent: reason" entries across every spawn path so `up` can report + exit non-zero
# at the end without killing seats that already launched earlier in the loop.
AGENT=""; MODEL=""; SKIPPED_SEATS=()
resolve_spec() {
  local SPEC="$1" FIELD
  AGENT="${SPEC%%:*}"; MODEL=""
  # Replace, never stack. Reaps here — as a plain statement — because the alternative home, RUN_CMD,
  # is always invoked as `cmd="$(RUN_CMD)"`, and command substitution would swallow run()'s output
  # into the launcher string. AGENT is set above and DIR is fixed, so this is the earliest safe point.
  reap_seat
  FIELD=""; [ "$SPEC" != "$AGENT" ] && FIELD="${SPEC#*:}"
  # Bare native seats use their own CLI defaults. Bare opencode-hosted seats MUST name their
  # provider implicitly: glm is the one non-obvious alias; every discovered/BYOM seat's label is
  # its provider id. Leaving FIELD empty is what handed qwen/glm to opencode's global DeepSeek.
  if [ -z "$FIELD" ]; then
    case "$AGENT" in
      codex|kimi|claude|gemini|dsh|opencode) ;;
      glm) FIELD="zai-coding-plan" ;;
      *) FIELD="$AGENT" ;;
    esac
  fi
  if [ -n "$FIELD" ]; then
    case "$FIELD" in
      */*) MODEL="$FIELD" ;;
      *)   MODEL="$(resolve_model "$AGENT" "$FIELD" "$TASK" "$DIFF")" || {
             echo "[crew] ✗ skipping seat '$AGENT' — model resolution failed for $FIELD ($TASK/$DIFF); remaining seats still launch" >&2
             SKIPPED_SEATS+=("$AGENT: model resolution failed for $FIELD ($TASK/$DIFF)")
             return 1
           }
           echo "  → $AGENT: live model $MODEL ($FIELD · $TASK/$DIFF)" ;;
    esac
  fi
}
# report_skipped_seats: prints a summary of every seat resolve_spec skipped this run (if any) and
# returns 1 so callers can propagate a non-zero exit — the whole point is that a batch with some
# skips still launched the rest of the crew, so this is a REPORT, not an abort.
report_skipped_seats() {
  [ "${#SKIPPED_SEATS[@]}" -gt 0 ] || return 0
  echo ""
  echo "✗✗ ${#SKIPPED_SEATS[@]} seat(s) skipped (model resolution failed) — the rest of the crew still launched:"
  local s
  for s in "${SKIPPED_SEATS[@]}"; do echo "   - $s"; done
  return 1
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
  # Anchored: the runner's argv ends with DIR, and without the $ a reap for …/proj also matches a
  # runner in …/proj2 — killing a SIBLING project's seat on a directory-name prefix collision.
  for pid in $(pgrep -f "crew-runner\.mjs $AGENT $DIR"'$' 2>/dev/null); do
    run "kill -9 $pid 2>/dev/null"
  done
}
# RUN_CMD must stay PURE: every caller invokes it as `cmd="$(RUN_CMD)"`, i.e. command substitution,
# which captures ALL stdout. Anything that prints — including run()'s `[dry]` echo — would be swallowed
# into the command string and end up inside the launcher. The reap therefore lives in resolve_spec(),
# which every spawn path calls as a plain statement immediately before this.
RUN_CMD() { printf 'cd %q && CREW_MODEL=%q RELAY_PROJECT=%q RELAY_URL=%q node %q %q %q' "$DIR" "$MODEL" "$PROJ" "$HUB_URL" "$BUS_DIR/bin/crew-runner.mjs" "$AGENT" "$DIR"; }

# ── tmux spawn: ONE session `trantor:$PROJ`, one named pane per seat, one Terminal window attached ────
spawn_tmux() {   # $@ = specs
  local first=1 SPEC
  # a pre-existing session for THIS project = the crew is already up; add missing seats as new panes.
  tmux has-session -t "$TMUX_SESS" 2>/dev/null && first=0
  for SPEC in "$@"; do
    resolve_spec "$SPEC" || continue
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
    resolve_spec "$SPEC" || continue
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
  # ── replace, never stack (workspace edition, 2026-08-07) ──────────────────────────────────────────
  # Every `up` used to create a brand-new workspace — no awareness of a crew already on screen — so
  # repeated ups (and the bus-verify RETRY path, which re-enters spawn_crew) stacked dead
  # trantor:<proj> tabs in the sidebar. Observed six deep on crebral-health. Now the NEWEST tracked
  # workspace for this project is REUSED: each spec becomes a fresh pane inside it, replacing any old
  # pane for the same agent; older stacked workspaces are closed. Rows are read even in DRY mode
  # (read-only) so tests can seed a board.
  local REUSE_WS="" line w
  local stale_ws=()
  if [ -f "$STATE" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      _parse_row "$line"
      { [ "$RP" = "$PROJ" ] && [ "$RK" = "cmuxws" ]; } || continue
      [ -n "$REUSE_WS" ] && stale_ws+=("$REUSE_WS")
      REUSE_WS="$RH"
    done < "$STATE"
  fi
  if [ "${#stale_ws[@]}" -gt 0 ]; then
    for w in "${stale_ws[@]}"; do
      echo "  → closing stale stacked crew workspace for $PROJ ($w)"
      _cmux_close_tab "$w"; _state_drop "$PROJ" "cmuxws" "" "$w"
    done
    prune_dead_state    # the closed workspaces' seat rows just died with them
  fi
  # Untracked strays: LIVE workspaces named trantor:<proj> that STATE doesn't know (rows lost, or a
  # pre-fix pileup). Adopt one as the reuse target if we have none; close the rest.
  if [ "$DRY" != "1" ]; then
    local named nid
    named="$(_cmux workspace list --id-format both --json 2>/dev/null | WSNAME="trantor:$PROJ" node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const o=JSON.parse(d.slice(d.search(/[\[{]/)));const a=Array.isArray(o)?o:(o.workspaces||[]);console.log(a.filter(x=>x.custom_title===process.env.WSNAME||x.name===process.env.WSNAME).map(x=>x.id).filter(Boolean).join(" "))}catch(e){}})')"
    for nid in $named; do
      [ "$nid" = "$REUSE_WS" ] && continue
      [ -f "$STATE" ] && grep -qF "$nid" "$STATE" && continue     # tracked → handled above
      if [ -z "$REUSE_WS" ]; then
        echo "  → adopting existing untracked crew workspace for $PROJ ($nid)"
        REUSE_WS="$nid"; record_state "$PROJ" "cmuxws" "__ws__" "$nid"
      else
        echo "  → closing stray crew workspace for $PROJ ($nid)"
        _cmux_close_tab "$nid"
      fi
    done
  fi
  # Grid tiling: COLS = ceil(sqrt(N)) → 2 seats side-by-side, 4 = 2×2, 6 = 3×2. Row 0 is built with
  # RIGHT splits off the previous column; each later row splits DOWN from the pane directly above it.
  # Every split TARGETS a recorded surface id (--surface) — never "whatever pane happens to be focused",
  # which is what produced the old staircase layout. (In REUSE mode a replaced seat splits off its OWN
  # old pane — keeping its spot — and added seats split right off the previous new pane; the fresh-grid
  # math only applies to a fresh workspace.)
  local N=$# COLS=1; while [ $(( COLS * COLS )) -lt "$N" ]; do COLS=$(( COLS + 1 )); done
  local SPEC wsid="" surf="" i=0
  local surfs=()
  [ -n "$REUSE_WS" ] && wsid="$REUSE_WS"
  for SPEC in "$@"; do
    resolve_spec "$SPEC" || continue
    local cmd launcher; cmd="$(RUN_CMD)"; launcher="$(_seat_launcher "$AGENT" "$cmd")"
    if [ -n "$REUSE_WS" ]; then
      # replace-in-place: split the fresh pane FIRST (targeting the agent's old pane when tracked),
      # then close the old pane — split-first so the workspace can never hit zero surfaces mid-swap.
      local OLD_SURF=""
      if [ -f "$STATE" ]; then
        while IFS= read -r line; do
          [ -n "$line" ] || continue
          _parse_row "$line"
          [ "$RP" = "$PROJ" ] && [ "$RK" = "cmux" ] && [ "$RA" = "$AGENT" ] && OLD_SURF="$RH"
        done < "$STATE"
      fi
      if [ "$DRY" = "1" ]; then
        echo "[dry] cmux: reuse workspace $wsid — new-split for $AGENT${OLD_SURF:+ (replacing $OLD_SURF)}"
        surf="%DRYT$i"
        [ -n "$OLD_SURF" ] && _cmux_close_term "$OLD_SURF"
      else
        local tflag=()
        if [ -n "$OLD_SURF" ]; then tflag=(--surface "$OLD_SURF")
        elif [ "$i" -gt 0 ] && [ -n "${surfs[$(( i - 1 ))]}" ]; then tflag=(--surface "${surfs[$(( i - 1 ))]}"); fi
        surf="$(_cmux new-split right --workspace "$wsid" ${tflag[@]+"${tflag[@]}"} --id-format uuids --json 2>/dev/null | _cmux_surf_json)"
        [ -n "$surf" ] || surf="$(_cmux new-split right --workspace "$wsid" --id-format uuids --json 2>/dev/null | _cmux_surf_json)"
        [ -n "$surf" ] && { _cmux send --surface "$surf" "bash $launcher" >/dev/null 2>&1; _cmux send-key --surface "$surf" enter >/dev/null 2>&1; }
        if [ -n "$OLD_SURF" ]; then _cmux_close_term "$OLD_SURF"; _state_drop "$PROJ" "cmux" "$AGENT" ""; fi
      fi
    elif [ "$i" = "0" ]; then
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
  # (no workspace-level "crew up" pill — the per-seat pills the runners push carry all the signal;
  # a fifth static pill just forced the sidebar into "Show more".)
  echo "— crew grouped in cmux: ONE workspace tab for $PROJ, seats tiled + sidebar status. Teardown (this project only): trantor down —"
}

# AppleScript fallback (cmux control socket off): same one-tab-per-project layout, minus native sidebar status.
spawn_cmux_applescript() {   # $@ = specs
  # Same grid math as spawn_cmux: COLS = ceil(sqrt(N)); row 0 splits RIGHT off the previous column,
  # later rows split DOWN from the terminal directly above — targeted by stable terminal id.
  local N=$# COLS=1; while [ $(( COLS * COLS )) -lt "$N" ]; do COLS=$(( COLS + 1 )); done
  local SPEC tabid="" termid="" i=0
  local terms=()
  # replace, never stack — AppleScript edition. No socket ⇒ no liveness list, so the newest tracked
  # tab is validated by asking cmux for it directly; a dead tracked tab is dropped, older stacked
  # tabs are closed. Reuse then rides the normal split path (i>0) from the first seat.
  local line t REUSE_TAB=""
  local stale_tabs=()
  if [ -f "$STATE" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      _parse_row "$line"
      { [ "$RP" = "$PROJ" ] && [ "$RK" = "cmuxws" ]; } || continue
      [ -n "$REUSE_TAB" ] && stale_tabs+=("$REUSE_TAB")
      REUSE_TAB="$RH"
    done < "$STATE"
  fi
  if [ "${#stale_tabs[@]}" -gt 0 ]; then
    for t in "${stale_tabs[@]}"; do
      echo "  → closing stale stacked crew workspace for $PROJ ($t)"
      _cmux_close_tab "$t"; _state_drop "$PROJ" "cmuxws" "" "$t"
    done
  fi
  if [ -n "$REUSE_TAB" ] && [ "$DRY" != "1" ]; then
    local ok; ok="$(osascript 2>/dev/null <<OSA
tell application "cmux"
  repeat with w in windows
    repeat with tt in tabs of w
      if (id of tt) is "$REUSE_TAB" then return "OK"
    end repeat
  end repeat
  return "ERR"
end tell
OSA
)"
    [ "$ok" = "OK" ] || { _state_drop "$PROJ" "cmuxws" "" "$REUSE_TAB"; _state_drop "$PROJ" "cmux" "" ""; REUSE_TAB=""; }
  fi
  [ -n "$REUSE_TAB" ] && { tabid="$REUSE_TAB"; echo "  → reusing existing crew workspace for $PROJ ($tabid)"; }
  for SPEC in "$@"; do
    resolve_spec "$SPEC" || continue
    local cmd launcher; cmd="$(RUN_CMD)"; launcher="$(_seat_launcher "$AGENT" "$cmd")"
    # In REUSE mode, replace-in-place: split off the agent's old terminal when tracked, close it after.
    local OLD_SURF=""
    if [ -n "$REUSE_TAB" ] && [ -f "$STATE" ]; then
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        _parse_row "$line"
        [ "$RP" = "$PROJ" ] && [ "$RK" = "cmux" ] && [ "$RA" = "$AGENT" ] && OLD_SURF="$RH"
      done < "$STATE"
    fi
    if [ -z "$tabid" ] && [ "$i" = "0" ]; then
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
      local dir target=""
      if [ -n "$OLD_SURF" ]; then dir="right"; target="$OLD_SURF"          # replace-in-place: keep the seat's spot
      elif [ "$i" -gt 0 ]; then
        if [ $(( i / COLS )) = "0" ]; then dir="right"; target="${terms[$(( i - 1 ))]}"
        else dir="down"; target="${terms[$(( i - COLS ))]}"; fi
      else dir="right"; fi                                                 # reuse mode, first seat, nothing tracked → focused terminal
      if [ "$DRY" = "1" ]; then
        echo "[dry] cmux(AppleScript): split $dir from ${target:-<focused>} + run 'bash $launcher'"; termid="%DRYT$i"
        [ -n "$OLD_SURF" ] && _cmux_close_term "$OLD_SURF"
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
        [ -n "$OLD_SURF" ] && [ -n "$termid" ] && [ "$termid" != "ERR" ] && { _cmux_close_term "$OLD_SURF"; _state_drop "$PROJ" "cmux" "$AGENT" ""; }
      fi
    fi
    terms+=("$termid")
    record_state "$PROJ" "cmux" "$AGENT" "$termid"
    echo "  → $AGENT seat in cmux workspace ($PROJ)"
    i=$(( i + 1 ))
  done
  echo "— crew grouped in cmux (AppleScript): ONE workspace tab for $PROJ, seats tiled. Teardown: trantor down —"
}

spawn_crew() {   # dispatch: herdr (explicit opt-in) → cmux → tmux → Terminal grid
  if [ "$HAVE_HERDR" = "1" ]; then spawn_herdr "$@"
  elif [ "$HAVE_CMUX" = "1" ]; then spawn_cmux "$@"
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

CREW_UI="Terminal windows"; [ "$HAVE_TMUX" = "1" ] && CREW_UI="tmux"; [ "$HAVE_CMUX" = "1" ] && CREW_UI="cmux"; [ "$HAVE_HERDR" = "1" ] && CREW_UI="herdr"
echo "— bringing up crew for $PROJ ($CREW_UI) —"
SPAWN_EPOCH=$(epoch_ms)
spawn_crew "$@"

if [ "$DRY" = "1" ]; then
  echo "— dry run: no bus verify —"
  report_skipped_seats
  exit $?
fi
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
report_skipped_seats
exit $?

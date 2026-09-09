#!/bin/bash
# trantor one-shot setup: hub service + config + CLI wiring + doctor.
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
[ -z "$NODE" ] && { echo "node >= 18 required"; exit 1; }
mkdir -p "$HOME/.agent-bus"
[ -f "$HOME/.agent-bus/config.json" ] || echo '{"url":"http://127.0.0.1:4477"}' > "$HOME/.agent-bus/config.json"
touch "$HOME/.agent-bus/.env"   # one place for provider API keys (e.g. DEEPSEEK_API_KEY=…)
if [ "$(uname)" = "Darwin" ]; then
  PL="$HOME/Library/LaunchAgents/com.trantor.hub.plist"
  sed -e "s|__NODE__|$NODE|" -e "s|__REPO__|$REPO|" "$REPO/deploy/com.trantor.hub.plist" > "$PL"
  launchctl bootout "gui/$(id -u)/com.trantor.hub" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PL"
  echo "✓ hub installed as launchd service (starts at login, restarts on crash)"
else
  echo "Linux: run the hub under systemd/tmux:  RELAY_PORT=4477 node $REPO/hub.mjs"
fi
# the economics engine — vendored in engine/, installed automatically (it IS the brain)
if [ -f "$REPO/engine/install.sh" ]; then
  echo "▸ installing the economics engine (routing + cost ledger)…"
  bash "$REPO/engine/install.sh" >/dev/null 2>&1 \
    && echo "✓ economics engine installed" \
    || echo "  (engine install failed — Trantor still works; the Advisor runs without live pricing. Retry: trantor setup)"
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "  note: add ~/.local/bin to your PATH";; esac
fi
# Graft — local code-graph MCP tools every seat can call (token-saving retrieval; NanoNets, MIT).
# Installed here so connect (next) wires it into each CLI; the graph self-refreshes per query and is
# a no-op where a project has no index (built per project at crew launch). Non-fatal if it fails.
#
# We probe by BUILDING, not by `command -v graft`. A bin link proves nothing about whether graft can
# parse: it depends on ten tree-sitter native bindings, all wired as `"install": "node-gyp-build"`.
# npm v12 turns lifecycle scripts and implicit node-gyp builds OFF by default, and the prebuilds that
# save us do not cover every platform — tree-sitter core and tree-sitter-python ship no linux-arm64.
# There, the gyp fallback that used to compile them no longer runs, `graft` is still on PATH, and a
# presence check prints a green tick over a tool that throws on first use. So the probe indexes a
# one-file fixture (~0.2s) and requires the symbol back: exit 0 alone can mean "parsed nothing".
# Every failure path is explicitly `|| rc=1` rather than leaning on set -e being suspended inside an
# `if` condition: this must return a verdict, never abort setup.
graft_works() {
  rc=0
  command -v graft >/dev/null 2>&1 || return 1
  d="$(mktemp -d 2>/dev/null)" || return 1
  printf 'export function graftProbe(n) {\n  return n;\n}\n' > "$d/probe.mjs" || rc=1
  if [ "$rc" -eq 0 ]; then
    ( cd "$d" && graft build . >/dev/null 2>&1 && graft skeleton probe.mjs . 2>/dev/null | grep -q graftProbe ) || rc=1
  fi
  rm -rf "$d"
  return "$rc"
}
if ! graft_works; then
  echo "▸ installing Graft (code-graph MCP tools for the seats)…"
  npm install -g @nanonets/graft >/dev/null 2>&1 || true
fi
if graft_works; then
  echo "✓ Graft installed"
elif command -v graft >/dev/null 2>&1; then
  echo "  (Graft is on PATH but cannot parse — almost certainly its native parsers were never built."
  echo "   npm v12 skips them by default. Fix: npm install -g @nanonets/graft --allow-scripts"
  echo "   Seats keep working without graft_* tools until then.)"
else
  echo "  (Graft install failed — seats keep working without graft_* tools; retry: npm install -g @nanonets/graft)"
fi

node "$REPO/bin/connect.mjs"
echo
node "$REPO/bin/doctor.mjs" || true
echo
echo "Next: claude plugin marketplace add sashabogi/trantor && claude plugin install trantor"
echo "Then: open Claude Code in any project and say \"fire up the crew\""

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
if ! command -v graft >/dev/null 2>&1; then
  echo "▸ installing Graft (code-graph MCP tools for the seats)…"
  npm install -g @nanonets/graft >/dev/null 2>&1 \
    && echo "✓ Graft installed" \
    || echo "  (Graft install failed — seats keep working without graft_* tools; retry: npm install -g @nanonets/graft)"
fi

node "$REPO/bin/connect.mjs"
echo
node "$REPO/bin/doctor.mjs" || true
echo
echo "Next: claude plugin marketplace add sashabogi/trantor && claude plugin install trantor"
echo "Then: open Claude Code in any project and say \"fire up the crew\""

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
# the economics engine (Scrooge) — install if missing, with consent
if ! command -v scrooge >/dev/null 2>&1; then
  printf "Install the Scrooge economics engine? (cheap-model routing + cost ledger) [Y/n] "
  read -r ANS </dev/tty 2>/dev/null || ANS=n   # non-interactive runs skip silently
  if [ "${ANS:-Y}" != "n" ] && [ "${ANS:-Y}" != "N" ]; then
    if command -v pipx >/dev/null 2>&1; then pipx install token-scrooge 2>/dev/null || true; fi
    command -v scrooge >/dev/null 2>&1 || { git clone -q https://github.com/sashabogi/token-scrooge "$HOME/.trantor-scrooge" 2>/dev/null && bash "$HOME/.trantor-scrooge/install.sh" 2>/dev/null || echo "  (manual install: https://github.com/sashabogi/token-scrooge)"; }
  fi
fi
node "$REPO/bin/connect.mjs"
echo
node "$REPO/bin/doctor.mjs" || true
echo
echo "Next: claude plugin marketplace add sashabogi/trantor && claude plugin install agent-bus"

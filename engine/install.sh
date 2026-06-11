#!/usr/bin/env bash
# Token Scrooge installer — make the cheap models do the grunt work.
# Usage:
#   git clone https://github.com/sashabogi/token-scrooge && cd token-scrooge && ./install.sh
#   curl -fsSL https://raw.githubusercontent.com/sashabogi/token-scrooge/main/install.sh | bash
set -euo pipefail

REPO_URL="${SCROOGE_REPO_URL:-https://github.com/sashabogi/token-scrooge}"
BIN_DIR="${SCROOGE_BIN_DIR:-$HOME/.local/bin}"
SCROOGE_HOME="${SCROOGE_HOME:-$HOME/.token-scrooge}"

say() { printf '%s\n' "$*"; }

# --- prerequisites -------------------------------------------------------
command -v python3 >/dev/null 2>&1 || { say "✗ python3 is required (3.8+)."; exit 1; }

# --- locate the repo (clone if piped via curl) ---------------------------
SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -z "${SRC:-}" ] || [ ! -f "$SRC/bin/scrooge" ]; then
  command -v git >/dev/null 2>&1 || { say "✗ git is required to bootstrap (or run ./install.sh from a clone)."; exit 1; }
  SRC="$SCROOGE_HOME/repo"
  say "▸ Fetching Token Scrooge into $SRC ..."
  if [ -d "$SRC/.git" ]; then git -C "$SRC" pull --ff-only --quiet; else git clone --depth 1 "$REPO_URL" "$SRC" --quiet; fi
fi

# --- install -------------------------------------------------------------
mkdir -p "$BIN_DIR" "$SCROOGE_HOME"
for b in scrooge scrooge-diverge scrooge-verify scrooge-drift scrooge-capabilities; do
  chmod +x "$SRC/bin/$b"
  ln -sf "$SRC/bin/$b" "$BIN_DIR/$b"   # symlink → `git pull` keeps tools current
done
# --- registry: refresh untouched copies, never clobber local edits ----------
# We keep the last-shipped template at $SCROOGE_HOME/registry.template.json as a
# baseline. If your live registry.json is byte-identical to that baseline you
# never edited it, so it's safe to roll forward to the new template. If it
# differs, you (or a manual sync) changed it — we preserve it and just flag that
# a newer template exists.
NEW_TPL="$SRC/registry.template.json"
OLD_TPL="$SCROOGE_HOME/registry.template.json"
REG="$SCROOGE_HOME/registry.json"
if [ ! -f "$REG" ]; then
  cp "$NEW_TPL" "$REG"                                   # fresh install
  say "✓ Registry installed."
elif cmp -s "$REG" "$NEW_TPL"; then
  : # already current — nothing to do
elif [ -f "$OLD_TPL" ] && cmp -s "$REG" "$OLD_TPL"; then
  cp "$NEW_TPL" "$REG"                                   # untouched copy → roll forward
  say "✓ Registry auto-refreshed to the latest models (no local edits detected)."
else
  say "⚠ A newer registry template is available, but your registry.json has local"
  say "  edits — leaving it untouched. Compare with:"
  say "      diff \"$REG\" \"$NEW_TPL\"     (or run: scrooge-drift)"
fi
cp "$NEW_TPL" "$OLD_TPL"                                 # update baseline for next run

# --- live-training seed: keep a current copy in $SCROOGE_HOME ----------------
# The committed seed (lessons.seed.json) ships starter guardrails. The user-local
# lessons.json (gitignored) is created from it on first use and never clobbered.
if [ -f "$SRC/lessons.seed.json" ]; then
  cp "$SRC/lessons.seed.json" "$SCROOGE_HOME/lessons.seed.json"
fi
# --- capability seed: quality scores for the weighted router (refreshed by scrooge-capabilities)
if [ -f "$SRC/capabilities.seed.json" ]; then
  cp "$SRC/capabilities.seed.json" "$SCROOGE_HOME/capabilities.seed.json"
fi

say "✓ Installed: scrooge, scrooge-diverge, scrooge-verify, scrooge-drift, scrooge-capabilities → $BIN_DIR"

# --- weekly self-maintenance: refresh model quality scores (capability routing) ----------
# macOS uses a user LaunchAgent (no Full Disk Access needed, unlike crontab); Linux uses cron.
# Idempotent and non-fatal — a failure here never blocks the install.
setup_weekly_refresh() {
  local tool="$BIN_DIR/scrooge-capabilities"
  local log="$SCROOGE_HOME/capabilities-refresh.log"
  [ -x "$tool" ] || return 0
  case "$(uname -s)" in
    Darwin)
      local label="com.tokenscrooge.capabilities"
      local plist="$HOME/Library/LaunchAgents/$label.plist"
      local py; py="$(command -v python3 || echo /usr/bin/python3)"
      mkdir -p "$HOME/Library/LaunchAgents"
      cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>$py</string><string>$tool</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>5</integer></dict>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
PLIST
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
      if launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null; then
        say "✓ Weekly capability refresh scheduled (LaunchAgent · Mondays 09:05)."
      else
        say "ℹ LaunchAgent written to $plist — load it with: launchctl bootstrap gui/$(id -u) \"$plist\""
      fi
      ;;
    *)
      local line="5 9 * * 1 $tool > $log 2>&1"
      if command -v crontab >/dev/null 2>&1; then
        if crontab -l 2>/dev/null | grep -q "scrooge-capabilities"; then
          say "✓ Weekly capability refresh already in crontab."
        elif ( crontab -l 2>/dev/null; printf '%s\n' "$line" ) | crontab - 2>/dev/null; then
          say "✓ Weekly capability refresh added to crontab (Mondays 09:05)."
        else
          say "ℹ Could not edit crontab automatically. Add this line yourself:"
          say "    $line"
        fi
      else
        say "ℹ No crontab found — schedule '$tool' weekly however you prefer."
      fi
      ;;
  esac
}
setup_weekly_refresh || true

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "⚠ $BIN_DIR is not on your PATH. Add it:"
     say "    echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc && source ~/.zshrc" ;;
esac

# --- first-run setup -----------------------------------------------------
if [ "${1:-}" = "--no-setup" ] || [ ! -t 0 ]; then
  say ""
  say "Next: run the setup wizard to pick your orchestrator and add API keys:"
  say "    scrooge setup"
else
  say ""
  "$SRC/bin/scrooge" setup
fi

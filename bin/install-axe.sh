#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo "AXe v2.1.1 requires macOS; install it on the Mac that hosts the iOS Simulator." >&2
  exit 1
fi

VERSION="2.1.1"
SHA256="8788838b1b32059d143cf06541b72fcaead85c16274457cdbff086510a5b17fa"
ARCHIVE="AXe-macOS-v${VERSION}-universal.tar.gz"
URL="https://github.com/cameroncooke/AXe/releases/download/v${VERSION}/${ARCHIVE}"
DEST="${HOME}/.local/share/trantor/axe/v${VERSION}"
BIN="${HOME}/.local/bin"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$DEST" "$BIN"
curl --fail --location --silent --show-error "$URL" -o "$TMP/$ARCHIVE"
echo "$SHA256  $TMP/$ARCHIVE" | shasum -a 256 -c -
tar -xzf "$TMP/$ARCHIVE" -C "$DEST"
ln -sfn "$DEST/axe" "$BIN/axe"
echo "Installed AXe v${VERSION} at $DEST/axe"
echo "Ensure $BIN is on PATH, then verify with: axe --version"

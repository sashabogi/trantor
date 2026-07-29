#!/bin/bash
# trantor — backup Postgres + hub data to a timestamped tarball.
# Safe to run while the hub is running (pg_dump is consistent per snapshot).
# Retention: keeps last $KEEP_DAYS days (default 30).
# Usage: ./deploy/backup.sh [--pg-password PASSWORD]
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/lib/trantor/backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"
PG_USER="${PG_USER:-trantor}"
PG_HOST="${PG_HOST:-127.0.0.1}"
PG_DB="${PG_DB:-trantor}"
DATA_DIR="${DATA_DIR:-/var/lib/trantor/data}"

PG_PASSWORD=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pg-password) PG_PASSWORD="$2"; shift 2 ;;
    -p) PG_PASSWORD="$2"; shift 2 ;;
    *) echo "unknown flag: $1"; exit 1 ;;
  esac
done

mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
BACKUP_FILE="$BACKUP_DIR/trantor-$TIMESTAMP.tar.gz"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Dump Postgres
if [ -n "$PG_PASSWORD" ]; then
  PGPASSWORD="$PG_PASSWORD" pg_dump -U "$PG_USER" -h "$PG_HOST" -d "$PG_DB" -Fc -f "$TMP/pg.dump"
else
  pg_dump -U "$PG_USER" -h "$PG_HOST" -d "$PG_DB" -Fc -f "$TMP/pg.dump"
fi

# Copy hub data (bus.json, identities, etc.)
if [ -d "$DATA_DIR" ]; then
  cp -r "$DATA_DIR" "$TMP/hub-data"
fi

tar -czf "$BACKUP_FILE" -C "$TMP" .

# Prune backups older than KEEP_DAYS
find "$BACKUP_DIR" -name "trantor-*.tar.gz" -mtime "+$KEEP_DAYS" -delete

echo "backup: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"
echo "retention: keeping last $KEEP_DAYS days"

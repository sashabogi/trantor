#!/bin/bash
# trantor — restore a backup created by backup.sh.
# WARNING: this drops and recreates the Postgres database.
# Usage: ./deploy/restore.sh <backup.tar.gz> [--pg-password PASSWORD]
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <backup.tar.gz> [--pg-password PASS]"
  echo "backups available:"
  ls -1 /var/lib/trantor/backups/ 2>/dev/null || echo "  (none)"
  exit 1
fi

BACKUP_FILE="$1"; shift
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

if [ ! -f "$BACKUP_FILE" ]; then
  echo "backup file not found: $BACKUP_FILE"
  exit 1
fi

echo "=== RESTORE from $BACKUP_FILE ==="
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

tar -xzf "$BACKUP_FILE" -C "$TMP"

# Ensure psql/pg_restore are available
command -v psql >/dev/null 2>&1 || { echo "psql not found — install postgresql-client"; exit 1; }
command -v pg_restore >/dev/null 2>&1 || { echo "pg_restore not found — install postgresql-client"; exit 1; }

# Determine connection mechanism
CONN=""
if [ -n "$PG_PASSWORD" ]; then
  export PGPASSWORD="$PG_PASSWORD"
  CONN=(-U "$PG_USER" -h "$PG_HOST" -d "$PG_DB")
else
  CONN=(-U "$PG_USER" -h "$PG_HOST" -d "$PG_DB")
fi

if [ -f "$TMP/pg.dump" ]; then
  echo "restoring Postgres..."
  psql "${CONN[@]}" -c "SELECT pg_terminate_backend(pg_stat_activity.pid) FROM pg_stat_activity WHERE pg_stat_activity.datname = '$PG_DB' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
  psql "${CONN[@]}" -c "DROP DATABASE IF EXISTS $PG_DB;" postgres >/dev/null 2>&1 || true
  psql "${CONN[@]}" -c "CREATE DATABASE $PG_DB OWNER $PG_USER;" postgres >/dev/null 2>&1 || true
  pg_restore --no-owner --no-privileges -U "$PG_USER" -h "$PG_HOST" -d "$PG_DB" -c "$TMP/pg.dump"
else
  echo "(no pg.dump in backup — skipping Postgres restore)"
fi

if [ -d "$TMP/hub-data" ]; then
  echo "restoring hub data..."
  rm -rf "$DATA_DIR"
  cp -r "$TMP/hub-data" "$DATA_DIR"
fi

echo "=== restore complete ==="

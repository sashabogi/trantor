#!/bin/bash
# trantor TIME-based retention — prune old events from Postgres.
# Keeps projections (tasks, messages, peers) — invariant 5 from store-contract.
# Run via cron: 0 3 * * * /opt/trantor/deploy/retention.sh
set -euo pipefail

RETENTION_DAYS="${RETENTION_DAYS:-90}"
CUTOFF_MS="$(node -e "const d=Number(process.env.RETENTION_DAYS||90); process.stdout.write(String(Date.now() - d*864e5))")"

docker exec trantor-pg psql -U trantor -d trantor -c "
  DELETE FROM events WHERE ts < ${CUTOFF_MS} AND type NOT IN ('created','moved','updated');
" 2>&1 | tail -1

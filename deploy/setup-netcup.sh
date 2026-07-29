#!/bin/bash
# trantor — netcup Debian 13 one-shot server setup. Run as root.
set -euo pipefail

echo "=== trantor netcup setup (node $(node --version)) ==="

if ! id trantor &>/dev/null; then
  useradd -r -m -d /var/lib/trantor -s /usr/sbin/nologin trantor
  echo "created trantor user"
fi

install -d -o trantor -g trantor -m 750 /opt/trantor
install -d -o trantor -g trantor -m 750 /var/lib/trantor/data
install -d -o trantor -g trantor -m 750 /var/lib/trantor/backups

if [ ! -f /opt/trantor/hub.mjs ]; then
  echo "copy repo to /opt/trantor first (e.g. rsync ./ netcup:/opt/trantor/), then re-run"
  exit 1
fi
chown -R trantor:trantor /opt/trantor

# secrets: generate Postgres password, write to /etc/trantor/env
if [ ! -f /etc/trantor/env ]; then
  PG_PASS="$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)"
  install -d -m 750 /etc/trantor
  cat > /etc/trantor/env <<EOF
PG_PASSWORD=$PG_PASS
EOF
  chmod 600 /etc/trantor/env
  echo "wrote /etc/trantor/env"
fi
source /etc/trantor/env
export PG_PASSWORD

# install dependencies (node 20 native — no build tools needed)
cd /opt/trantor
npm install --omit=dev --no-audit --no-fund 2>/dev/null || true
chown -R trantor:trantor node_modules

# Dockerised Postgres
echo "starting Postgres..."
docker compose -f deploy/docker-compose.yml up -d
RETRIES=30
until docker exec trantor-pg pg_isready -U trantor -d trantor 2>/dev/null; do
  sleep 1; ((RETRIES--))
  if [ "$RETRIES" -le 0 ]; then echo "Postgres failed to start after 30s"; exit 1; fi
done
echo "Postgres ready"

# apply schema (from store-contract.mjs)
echo "applying schema..."
SCHEMA_SQL="$(node --input-type=module --eval '
  import { SCHEMA_SQL } from "./lib/store-contract.mjs";
  console.log(SCHEMA_SQL);
' 2>/dev/null || true)"
if [ -n "$SCHEMA_SQL" ]; then
  echo "$SCHEMA_SQL" | docker exec -i trantor-pg psql -U trantor -d trantor 2>/dev/null || true
fi
echo "  schema applied"

# systemd unit
cp deploy/trantor-hub.service /etc/systemd/system/trantor-hub.service
systemctl daemon-reload
systemctl enable --now trantor-hub

# crons: daily backup + nightly retention
chmod +x deploy/backup.sh deploy/retention.sh deploy/restore.sh
echo "0 2 * * * root /opt/trantor/deploy/backup.sh" > /etc/cron.d/trantor
echo "0 3 * * * root /opt/trantor/deploy/retention.sh" >> /etc/cron.d/trantor

echo ""
echo "=== done ==="
echo "Hub:      http://100.79.242.104:4477"
echo "Logs:     journalctl -u trantor-hub -f"
echo "Backups:  /var/lib/trantor/backups/"
echo "Restore:  bash /opt/trantor/deploy/restore.sh <file>"

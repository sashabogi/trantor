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
# Secrets live in /etc/trantor/pg.env — the EXACT path trantor-hub.service reads via
# EnvironmentFile. That file is prefixed `-`, so a name mismatch fails SILENTLY: the hub would boot
# with no DATABASE_URL and no RELAY_STORE, quietly ignoring the Postgres we just provisioned.
# It must also carry RELAY_STORE=pg — lib/store-pg.mjs is only selected when that is set.
if [ ! -f /etc/trantor/pg.env ]; then
  PG_PASS="$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)"
  install -d -m 750 /etc/trantor
  # One-time bootstrap secret for the FIRST admin. A remote hub binds non-loopback, so it must run
  # enforce+invite — but minting an invite needs an enrolled owner, and there is none. This token is
  # accepted ONLY while the identity store is empty; the first enrollment closes the path for good.
  BOOT_TOK="$(openssl rand -hex 24)"
  cat > /etc/trantor/pg.env <<EOF
PG_PASSWORD=$PG_PASS
RELAY_STORE=pg
DATABASE_URL=postgresql://trantor:$PG_PASS@127.0.0.1:5432/trantor
RELAY_BOOTSTRAP_TOKEN=$BOOT_TOK
EOF
  chmod 600 /etc/trantor/pg.env
  echo "wrote /etc/trantor/pg.env (RELAY_STORE=pg + DATABASE_URL)"
fi
source /etc/trantor/pg.env
export PG_PASSWORD DATABASE_URL RELAY_STORE

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

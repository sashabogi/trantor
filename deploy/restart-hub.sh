#!/bin/bash
# Guarded production restart: an unhealthy durable writer means RAM contains the only current copy.
set -euo pipefail

FORCE=0
if [ "${1:-}" = "--force" ]; then
  FORCE=1
  shift
fi
if [ "$#" -ne 0 ]; then
  echo "usage: deploy/restart-hub.sh [--force]" >&2
  exit 2
fi

HUB_URL="${RELAY_HUB_URL:-http://127.0.0.1:4477}"
HEALTH=""
if HEALTH="$(curl --fail --silent --show-error --max-time 5 "$HUB_URL/health")"; then
  REFUSAL="$(node --input-type=module -e '
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    let health;
    try { health = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { process.stdout.write("hub health response was not valid JSON"); process.exit(0); }
    const p = health.persist;
    if (!p || p.ok !== false) process.exit(0);
    const age = Number(p.failingSinceMs || 0);
    const span = age >= 60000 ? `${Math.floor(age / 60000)}m ${Math.floor((age % 60000) / 1000)}s` : `${Math.floor(age / 1000)}s`;
    process.stdout.write(`hub persistence has failed for ${span} (${Number(p.retries || 0)} retries): ${String(p.lastError || "unknown error")}. Restarting risks losing every state change since persistence stopped.`);
  ' <<<"$HEALTH")"
  if [ -n "$REFUSAL" ] && [ "$FORCE" -ne 1 ]; then
    echo "REFUSED: $REFUSAL" >&2
    echo "Resolve persistence first, or rerun with --force to accept the data-loss risk." >&2
    exit 1
  fi
  if [ -n "$REFUSAL" ]; then
    echo "WARNING: --force accepted: $REFUSAL" >&2
  fi
else
  echo "WARNING: $HUB_URL/health was unreachable; proceeding because no running hub state can be inspected." >&2
fi

systemctl restart trantor-hub
echo "restarted trantor-hub"

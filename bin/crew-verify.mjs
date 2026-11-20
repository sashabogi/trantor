#!/usr/bin/env node
// crew-verify checks that spawned crew sessions registered with the hub.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const ti = args.indexOf("--timeout");
const TIMEOUT = ti >= 0 ? Number(args.splice(ti, 2)[1]) : 30;
// --since anchors freshness to the launcher's pre-spawn epoch, so early boot registration counts.
const si = args.indexOf("--since");
const SINCE = si >= 0 ? Number(args.splice(si, 2)[1]) : NaN;
const [PROJ, ...AGENTS] = args;
if (!PROJ || !AGENTS.length) { console.error("usage: crew-verify.mjs <project> <agent...> [--timeout 30] [--since <ms>]"); process.exit(2); }

// /peers requires a signed request when hub auth is enforced.
import { resolveHub } from "../lib/project.mjs";
import { resolveOwnerIdentity } from "../lib/identity.mjs";
import { sfetchJson } from "../lib/signed-fetch.mjs";
const HUB = process.env.RELAY_URL || resolveHub(PROJ);
const VERIFY_ID = await resolveOwnerIdentity(HUB);
// Keep freshness anchored to spawn while measuring the polling deadline from this process start.
const DEADLINE = Date.now() + TIMEOUT * 1000;
const FRESH_SINCE = Number.isFinite(SINCE) ? SINCE : Date.now();

(async () => {
  const want = new Set(AGENTS.map(a => `${a}:${PROJ}`));
  const up = new Set();
  while (Date.now() < DEADLINE && up.size < want.size) {
    try {
      const { peers } = await (await sfetchJson(`${HUB}/peers`, { method: "GET", identity: VERIFY_ID })).json();
      for (const p of peers) if (want.has(p.session) && p.lastSeen >= FRESH_SINCE) up.add(p.session);
    } catch {}
    if (up.size < want.size) await new Promise(s => setTimeout(s, 1500));
  }
  const failed = [...want].filter(s => !up.has(s));
  for (const s of want) console.log(`${up.has(s) ? "✓" : "✗"} ${s} ${up.has(s) ? "on the bus" : `NOT on the bus after ${TIMEOUT}s`}`);
  if (failed.length) { console.log(`FAILED:${failed.map(s => s.split(":")[0]).join(",")}`); process.exit(1); }
})();

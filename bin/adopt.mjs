#!/usr/bin/env node
// trantor adopt — graduate a project from the machine-local hub to a remote hub, in ONE command.
//
//   trantor adopt <project> [--hub <url>] [--dry] [--force]
//
// The crm-platform lesson: a new project is born unpinned, lives on the local hub (by design —
// TDD §12.1's fallback), and moving it to the shared hub was three separate ceremonies (enroll
// identities, migrate data, write the pin) spread across two machines. This collapses them:
//
//   1. read the project's rows off the LOCAL hub state (tasks/events/messages)
//   2. enroll this machine's identities for the project on the target hub (owner-signed invites):
//      the orchestrator (<host>:<project>) as owner, every existing seat key as write
//   3. POST /import (owner-signed) — the hub merges, remapping colliding card ids itself
//   4. verify the count round-trip, THEN write the routing pin
//
// No ssh, no direct Postgres access: the hub's /import endpoint is the migration surface.
// Live sessions keep their old routing until restarted — adopt SAYS so rather than pretending.
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { hostId } from "../lib/project.mjs";
import { loadOrCreate, signRequest } from "../lib/identity.mjs";
import { sfetchJson } from "../lib/signed-fetch.mjs";

const argv = process.argv.slice(2);
const PROJECT = argv.find(a => !a.startsWith("--")) || "";
const arg = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? (argv[i + 1] ?? "") : ""; };
const has = (k) => argv.includes(`--${k}`);
if (!PROJECT) { console.error("usage: trantor adopt <project> [--hub <url>] [--dry] [--force]"); process.exit(1); }

const BUS_DIR = process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus");
const CONFIG_PATH = join(BUS_DIR, "config.json");
let config = {}; try { config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch {}
const LOCAL = config.url || "http://127.0.0.1:4477";

// target: --hub wins; else the hub most of the fleet already lives on
const pinCounts = {};
for (const u of Object.values(config.hubs || {})) if (!/127\.0\.0\.1|localhost/.test(u)) pinCounts[u] = (pinCounts[u] || 0) + 1;
const TARGET = arg("hub") || Object.entries(pinCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
if (!TARGET) { console.error("no remote hub known — pass --hub <url> (no non-local pins exist to infer one from)"); process.exit(1); }
if ((config.hubs || {})[PROJECT] === TARGET) { console.log(`${PROJECT} is already pinned to ${TARGET} — nothing to do.`); process.exit(0); }

// 1. the project's rows, straight from the local hub's state file (full fidelity, no pagination)
const statePath = process.env.RELAY_STATE || join(BUS_DIR, "bus.json");
let local = {}; try { local = JSON.parse(readFileSync(statePath, "utf8")); } catch {}
const tasks = (local.tasks || []).filter(t => t.project === PROJECT);
const events = (local.events || []).filter(e => e.project === PROJECT);
const messages = (local.messages || []).filter(m => (m.project || "") === PROJECT);
const livePeers = Object.entries(local.peers || {}).filter(([, p]) => p.project === PROJECT && Date.now() - (p.lastSeen || 0) < 5 * 60 * 1000);

const owner = String(config.ownerIdentity || "");
if (!owner) { console.error("config.ownerIdentity is not set — enrolments need an owner to sign invites"); process.exit(1); }

// identities: the orchestrator as owner + every seat key that already exists for this project
const safe = (s) => s.replace(/[^A-Za-z0-9_.-]/g, "_");
const keyFiles = (() => { try { return readdirSync(join(BUS_DIR, "keys")); } catch { return []; } })();
const orchestrator = `${hostId()}:${PROJECT}`;
const seats = keyFiles
  .filter(f => f.endsWith(`_${safe(PROJECT)}.json`))
  .map(f => f.replace(/\.json$/, "").replace(`_${safe(PROJECT)}`, `:${PROJECT}`))
  .filter(n => n !== safe(orchestrator).replace(`_${safe(PROJECT)}`, `:${PROJECT}`) && n !== orchestrator);

console.log(`adopt    : ${PROJECT}`);
console.log(`from     : ${LOCAL} (${tasks.length} cards · ${events.length} events · ${messages.length} messages)`);
console.log(`to       : ${TARGET}`);
console.log(`enroll   : ${orchestrator} (owner)${seats.length ? ` + ${seats.join(", ")} (write)` : ""}`);
if (livePeers.length) console.log(`⚠ LIVE   : ${livePeers.map(([s]) => s).join(", ")} — they keep the OLD routing until restarted`);
if (has("dry")) { console.log("\n[dry run] nothing changed."); process.exit(0); }

const ownerId = loadOrCreate(owner, "human");
async function enroll(name, role) {
  const invBody = JSON.stringify({ scopes: [{ project: PROJECT, role }], ttlSec: 600 });
  const invSig = signRequest(ownerId, { method: "POST", path: "/invite", body: invBody });
  const inv = await (await fetch(`${TARGET}/invite`, { method: "POST", headers: { "content-type": "application/json", ...invSig }, body: invBody, signal: AbortSignal.timeout(8000) })).json();
  if (!inv.token) throw new Error(`invite for ${name}: ${inv.error || "no token"}`);
  const id = loadOrCreate(name, "agent");
  const body = JSON.stringify({ token: inv.token, name, pubkey: id.pubkey, kind: "agent" });
  const sig = signRequest(id, { method: "POST", path: "/enroll", body });
  const r = await (await fetch(`${TARGET}/enroll`, { method: "POST", headers: { "content-type": "application/json", ...sig }, body, signal: AbortSignal.timeout(8000) })).json();
  if (!r.ok) throw new Error(`enroll ${name}: ${r.error || "failed"}`);
  console.log(`  ✓ enrolled ${name} (${role})`);
}

try {
  await enroll(orchestrator, "owner");
  for (const s of seats) await enroll(s, "write");

  const imp = await sfetchJson(`${TARGET}/import`, {
    identity: ownerId,
    payload: { project: PROJECT, tasks, events, messages, by: owner, force: has("force") },
    signal: AbortSignal.timeout(60000),
  });
  const impJson = await imp.json();
  if (!impJson.ok) throw new Error(`import: ${impJson.error || imp.status}${impJson.existing ? ` (${impJson.existing} cards already there — --force to merge anyway)` : ""}`);
  console.log(`imported : ${impJson.tasks} cards · ${impJson.events} events · ${impJson.messages} messages${impJson.remapped ? ` · ${impJson.remapped} card id(s) remapped` : ""}`);

  // verify BEFORE pinning — a pin pointing at a hub that doesn't have the data is a data outage
  const check = await (await sfetchJson(`${TARGET}/tasks?project=${encodeURIComponent(PROJECT)}`, { method: "GET", identity: ownerId })).json();
  const remoteCount = (check.tasks || []).length;
  if (remoteCount < tasks.length) throw new Error(`verify: target has ${remoteCount} cards, local has ${tasks.length} — NOT pinning`);
  console.log(`verified : ${remoteCount} cards on target`);

  config.hubs = config.hubs || {};
  config.hubs[PROJECT] = TARGET;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  console.log(`pinned   : ${PROJECT} → ${TARGET}`);
  if (livePeers.length) {
    console.log(`\n⚠ live sessions still route to the OLD hub until restarted:`);
    for (const [s] of livePeers) console.log(`    ${s}`);
    console.log(`  crew seats: trantor down && trantor up · Claude sessions: restart them when convenient.`);
  }
  console.log(`\n✓ adopted. New sessions on ${PROJECT} land on ${TARGET}.`);
} catch (e) {
  console.error(`\n✗ adopt failed: ${e.message}`);
  console.error("nothing was pinned — routing is unchanged.");
  process.exit(1);
}

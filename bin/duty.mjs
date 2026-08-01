#!/usr/bin/env node
// trantor duty — the always-on fleet DUTY AGENT: one seat that watches the whole hub and triages
// so the human never has to be a switchboard.
//
//   trantor duty up [--hub <url>] [--agent claude]     start (idempotent — reaps a prior seat)
//   trantor duty down                                  stop
//   trantor duty status                                pid + last turns + presence
//
// Division of labor (the overseer doctrine, extended): DETECTION stays mechanical and hub-side —
// RELAY_DUTY_SESSION makes the hub DM this seat when a direct message sits undelivered past
// RELAY_DUTY_UNDELIVERED_MS or the overseer emits a warning. The SEAT only triages: relay, wake,
// annotate, and only involves the human when a real decision is needed. It runs under the same
// crew-runner that keeps crew seats alive (long-poll wake, turn telemetry, failure reporting) —
// just with a triage doctrine instead of "work your card" (RUNNER_RULES / CREW_KICKOFF).
import { spawn, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadOrCreate } from "../lib/identity.mjs";
import { sfetchJson } from "../lib/signed-fetch.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUS = process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus");
const DIR = join(BUS, "fleet");                  // the seat's cwd — project name "fleet"
const PIDF = join(BUS, "duty.pid");
const LOGF = join(BUS, "duty.log");

const argv = process.argv.slice(2);
const cmd = argv[0] || "status";
const val = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? (argv[i + 1] || d) : d; };

let config = {}; try { config = JSON.parse(readFileSync(join(BUS, "config.json"), "utf8")); } catch {}
// The fleet hub: where the projects live. Default = the most common per-project hub in config,
// falling back to the global url — a fleet watcher belongs where the fleet is.
function fleetHub() {
  const counts = new Map();
  for (const u of Object.values(config.hubs || {})) counts.set(u, (counts.get(u) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return val("hub", top?.[0] || config.url || "http://127.0.0.1:4477");
}

const AGENT = val("agent", "claude");
const SESSION = `${AGENT}:fleet`;

const RULES = `Rules: you are ${SESSION}, the trantor fleet DUTY AGENT — the always-on triage seat. You NEVER write code and NEVER edit project files. On every wake: (1) read the message(s) that woke you; (2) triage with your relay tools — relay_peers for who is live/down, relay_board with the project param for any board, relay_inbox for your own backlog; runner logs live at ~/.agent-bus/logs/<agent>-<project>.jsonl if a seat looks dead; (3) ACT: an UNDELIVERED escalation means the recipient is idle, deaf (wrong hub / stale hooks — a known failure mode), or gone — relay the content to a live session that can act, wake a crew seat with a direct message, or post the information into the project lane so the human's app notifies them; an OVERSEER warning means two parties may collide — message them to coordinate; a seat reported down/errored — check its log tail and either resend its contract or report exactly what is needed. (4) Report each action in ONE bus message (<280 chars) to the lane it concerns. If only a human can decide, say exactly that, in that lane, once. Then END YOUR TURN — the runner wakes you for the next event.`;

const KICKOFF = `You are ${SESSION}, the fleet duty agent, freshly started. Do a short patrol: relay_peers (note anything down/errored), then relay_inbox. Handle what is actionable per the Rules, post one line to the bus saying the duty seat is on watch, and end your turn.\n\n${RULES}`;

async function ensureFleetIdentity(hub) {
  const id = loadOrCreate(SESSION, "agent");
  const probe = await sfetchJson(`${hub}/peers`, { method: "GET", identity: id, signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (probe && probe.status !== 401) return true;          // enrolled (or hub not enforcing)
  // Not enrolled: mint an owner invite with FLEET-WIDE write (write ⊇ read) and enroll with it.
  const owner = loadOrCreate(config.ownerIdentity || "admin", "human");
  const inv = await sfetchJson(`${hub}/invite`, { identity: owner, payload: { scopes: [{ project: "*", role: "write" }], ttlSec: 3600 }, signal: AbortSignal.timeout(5000) });
  const invJson = await inv.json().catch(() => ({}));
  if (!inv.ok || !invJson.token) { console.error(`could not mint fleet invite on ${hub}: ${invJson.error || inv.status} — is ${config.ownerIdentity || "admin"} the owner there?`); return false; }
  const enr = await sfetchJson(`${hub}/enroll`, { identity: id, payload: { token: invJson.token, pubkey: id.pubkey, name: SESSION, kind: "agent" }, signal: AbortSignal.timeout(5000) });
  const enrJson = await enr.json().catch(() => ({}));
  if (!enr.ok) { console.error(`fleet enroll failed: ${enrJson.error || enr.status}`); return false; }
  console.log(`— enrolled ${SESSION} on ${hub} with fleet-wide write —`);
  return true;
}

function alivePid() {
  try {
    const pid = Number(readFileSync(PIDF, "utf8"));
    if (pid && process.kill(pid, 0) === undefined) return pid;
  } catch {}
  return 0;
}

if (cmd === "up") {
  const hub = fleetHub();
  mkdirSync(DIR, { recursive: true });
  const prior = alivePid();
  if (prior) { console.log(`— reaping prior duty seat (pid ${prior}) —`); try { process.kill(prior); } catch {} }
  try { execSync(`pkill -f "crew-runner.mjs ${AGENT} ${DIR}"`, { stdio: "ignore" }); } catch {}
  if (!(await ensureFleetIdentity(hub))) process.exit(1);
  const out = openSync(LOGF, "a");
  const child = spawn(process.execPath, [join(ROOT, "bin", "crew-runner.mjs"), AGENT, DIR], {
    detached: true, stdio: ["ignore", out, out],
    env: { ...process.env, RELAY_URL: hub, RUNNER_RULES: RULES, CREW_KICKOFF: KICKOFF },
  });
  child.unref();
  writeFileSync(PIDF, String(child.pid));
  console.log(`— duty agent up: ${SESSION} (pid ${child.pid}) watching ${hub} — log: ${LOGF}`);
  console.log(`  hub feeds it: undelivered DMs (>${Math.round(Number(process.env.RELAY_DUTY_UNDELIVERED_MS || 600000) / 60000)}m) + overseer warnings — set RELAY_DUTY_SESSION=${SESSION} on the hub service.`);
  process.exit(0);
}

if (cmd === "down") {
  const pid = alivePid();
  if (pid) { try { process.kill(pid); } catch {} console.log(`— duty seat stopped (pid ${pid}) —`); }
  else console.log("no duty seat running");
  try { execSync(`pkill -f "crew-runner.mjs ${AGENT} ${DIR}"`, { stdio: "ignore" }); } catch {}
  try { rmSync(PIDF, { force: true }); } catch {}
  process.exit(0);
}

// status
{
  const pid = alivePid();
  console.log(pid ? `duty seat RUNNING (pid ${pid}) as ${SESSION}` : "duty seat NOT running");
  try {
    const lines = readFileSync(join(BUS, "logs", `${AGENT}-fleet.jsonl`), "utf8").trim().split("\n").slice(-3);
    console.log("last turns:"); for (const l of lines) console.log(`  ${l}`);
  } catch { console.log("(no turns logged yet)"); }
  process.exit(0);
}

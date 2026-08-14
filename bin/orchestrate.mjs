#!/usr/bin/env node
// trantor orchestrate — a per-project ORCHESTRATOR seat with a mission note and a pulse.
//
// The shape is Scape's Lloyd/Argus (the loop-orchestrator pattern proven in the wild), built on
// Trantor's own substrate: crew-runner keeps the seat alive, the bus carries its messages, the
// board is its ticket table, lessons are its tribal knowledge. What the pulse adds is a metronome —
// "[pulse] re-read your mission note and continue" every N minutes — so the seat works its mission
// even when the bus is silent, instead of being deaf between messages like a crew seat.
//
//   trantor orchestrate up [--every 10m] [--agent claude] [--hub <url>]   start HERE (this project)
//   trantor orchestrate down                                              stop this project's orchestrator
//   trantor orchestrate status                                            pid + mission + last turns
//
// The mission lives in MISSION.md in the project directory — the operator writes it, the seat
// re-reads it every pulse, and pending questions/proposals belong IN it. No mission = the seat
// stands by (boot discipline: it never invents work).
import { spawn, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadOrCreate } from "../lib/identity.mjs";
import { sfetchJson } from "../lib/signed-fetch.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUS = process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus");
const DIR = process.cwd();                       // the orchestrator works THIS project, from its root
const PROJ = basename(DIR);
const PIDF = join(BUS, `orch-${PROJ}.pid`);
const LOGF = join(BUS, `orch-${PROJ}.log`);

const argv = process.argv.slice(2);
const cmd = argv[0] || "status";
const val = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? (argv[i + 1] || d) : d; };

let config = {}; try { config = JSON.parse(readFileSync(join(BUS, "config.json"), "utf8")); } catch {}
function projectHub() {
  return val("hub", config.hubs?.[PROJ] || config.url || "http://127.0.0.1:4477");
}

/** "10m" / "90s" / "1h" → ms. The default matches the pattern's field-proven cadence. */
function parseEvery(v) {
  const m = String(v || "10m").match(/^(\d+)(s|m|h)?$/);
  if (!m) { console.error(`bad --every '${v}' (want e.g. 90s, 10m, 1h)`); process.exit(1); }
  return Number(m[1]) * { s: 1000, m: 60000, h: 3600000 }[m[2] || "m"];
}

const AGENT = val("agent", "claude");
// `-orch` keeps the orchestrator distinguishable from a same-CLI crew seat on the same project —
// the naming the fleet already uses (kimi-orch:<project> since the kimi port).
const SESSION = `${AGENT}-orch:${PROJ}`;

// The doctrine. Verbs from the Argus prompts that demonstrably work, grounded in Trantor's tools.
const RULES = `Rules: you are ${SESSION}, the ORCHESTRATOR for project ${PROJ}. Your mission lives in MISSION.md in this directory; the operator writes it, you execute it. BOOT DISCIPLINE: if MISSION.md is missing, empty, or has no actionable mission, reply only that you are standing by and end your turn — do NOT invent work, create files or cards, or spawn anything. On every pulse or message: (1) re-read MISSION.md; (2) TRIBAL KNOWLEDGE FIRST — before staffing or starting ANY task, query the board for related past cards and lessons (relay_board; the board is your ticket history and prior work may already answer half of it); (3) NEVER DUPLICATE — before creating a card or engaging a session for a task, check whether an existing card or live session (relay_peers) already covers it, and never re-create work something is already on; (4) if the mission names log files or running services, READ THE LOGS — a noisy-but-not-erroring problem nobody reported becomes a card for the human to triage; (5) file cards for bugs and ideas you surface (relay_task_add) — that is your voice, the human triages them; (6) unblock stalled work: message the responsible session directly (relay_send), never ask the human to relay; (7) if your mission needs a STANDING PERMISSION you lack (deploy rights, push-to-main, spending, scope beyond the mission), relay_propose it with a full bound — scope, condition, exclusions — and move on with what you CAN do; never assume you have it, never nag, and never re-propose a denial; permissions the operator has APPROVED arrive in your context as <trantor-grants> — those are standing decisions you act on within their bound without re-asking; (8) record what you did: move cards, then ONE bus report (<280 chars) to the project lane. If only the human can decide something, write the question at the END of MISSION.md under '## Pending for operator' (create the section if missing) AND say it in your bus report, once. Then END YOUR TURN — the runner pulses you on cadence and wakes you for messages.`;

const KICKOFF = `You are ${SESSION}, freshly started as this project's orchestrator. Read MISSION.md if it exists. If it has an actionable mission, do ONE opening survey (board via relay_board, peers via relay_peers) and post a one-line "orchestrator on watch" report to the bus. If there is no actionable mission, reply only that you are standing by. Then end your turn.\n\n${RULES}`;

async function ensureIdentity(hub) {
  const id = loadOrCreate(SESSION, "agent");
  const probe = await sfetchJson(`${hub}/peers`, { method: "GET", identity: id, signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (probe && probe.status !== 401) return true;
  const owner = loadOrCreate(config.ownerIdentity || "admin", "human");
  const inv = await sfetchJson(`${hub}/invite`, { identity: owner, payload: { scopes: [{ project: PROJ, role: "write" }], ttlSec: 3600 }, signal: AbortSignal.timeout(5000) }).catch(() => null);
  const invJson = await inv?.json().catch(() => ({})) ?? {};
  if (!inv?.ok || !invJson.token) { console.error(`could not mint invite on ${hub}: ${invJson.error || (inv ? inv.status : "unreachable")}`); return false; }
  const enr = await sfetchJson(`${hub}/enroll`, { identity: id, payload: { token: invJson.token, pubkey: id.pubkey, name: SESSION, kind: "agent" }, signal: AbortSignal.timeout(5000) });
  if (!enr.ok) { console.error(`enroll failed: ${(await enr.json().catch(() => ({}))).error || enr.status}`); return false; }
  console.log(`— enrolled ${SESSION} on ${hub} (write on ${PROJ}) —`);
  return true;
}

function alivePid() {
  try {
    const pid = Number(readFileSync(PIDF, "utf8"));
    if (pid) { process.kill(pid, 0); return pid; }
  } catch {}
  return 0;
}

if (cmd === "up") {
  const hub = projectHub();
  const pulseMs = parseEvery(val("every", "10m"));
  const prior = alivePid();
  if (prior) { console.log(`— reaping prior orchestrator (pid ${prior}) —`); try { process.kill(prior); } catch {} }
  try { execSync(`pkill -f "crew-runner.mjs ${AGENT}-orch ${DIR}"`, { stdio: "ignore" }); } catch {}
  if (!(await ensureIdentity(hub))) process.exit(1);
  if (!existsSync(join(DIR, "MISSION.md"))) {
    console.log(`  note: no MISSION.md here — the seat will STAND BY until you write one (boot discipline).`);
  }
  const out = openSync(LOGF, "a");
  // The seat's AGENT is `<agent>-orch` so crew tooling (prune, per-seat down) treats it as its own
  // seat; crew-runner resolves the CLI by stripping nothing — so pass the real agent via CREW_CLI?
  // No: crew-runner keys CLI by its first arg. `claude-orch` is not a known CLI, so we pass the
  // REAL agent and override the session name instead.
  const child = spawn(process.execPath, [join(ROOT, "bin", "crew-runner.mjs"), AGENT, DIR], {
    detached: true, stdio: ["ignore", out, out],
    env: {
      ...process.env,
      RELAY_URL: hub,
      RUNNER_SESSION: SESSION,
      RUNNER_RULES: RULES,
      CREW_KICKOFF: KICKOFF,
      RUNNER_PULSE_MS: String(pulseMs),
      RUNNER_MISSION_FILE: "MISSION.md",
    },
  });
  child.unref();
  writeFileSync(PIDF, String(child.pid));
  console.log(`— orchestrator up: ${SESSION} (pid ${child.pid}) · pulse every ${val("every", "10m")} · hub ${hub}`);
  console.log(`  mission: ${join(DIR, "MISSION.md")} — log: ${LOGF}`);
  process.exit(0);
}

if (cmd === "down") {
  const pid = alivePid();
  if (pid) { try { process.kill(pid); } catch {} console.log(`— orchestrator stopped (pid ${pid}) —`); }
  else console.log(`no orchestrator running for ${PROJ}`);
  try { execSync(`pkill -f "crew-runner.mjs ${AGENT}-orch ${DIR}"`, { stdio: "ignore" }); } catch {}
  try { rmSync(PIDF, { force: true }); } catch {}
  process.exit(0);
}

// status
{
  const pid = alivePid();
  console.log(pid ? `orchestrator RUNNING (pid ${pid}) as ${SESSION}` : `no orchestrator running for ${PROJ}`);
  const mission = join(DIR, "MISSION.md");
  console.log(existsSync(mission) ? `mission: ${mission}` : "mission: NONE — the seat stands by until MISSION.md exists");
  try {
    const lines = readFileSync(join(BUS, "logs", `${AGENT}-${PROJ}.jsonl`), "utf8").trim().split("\n").slice(-3);
    console.log("last turns:"); for (const l of lines) console.log(`  ${l}`);
  } catch { console.log("(no turns logged yet)"); }
  process.exit(0);
}

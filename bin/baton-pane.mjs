#!/usr/bin/env node
// The --baton pane leg (#5643). When the dying session lives in a hosted pane, the Terminal
// spawn is exactly wrong (the fresh window lands on the surface the operator is leaving), so
// spawnFresh refuses — and until now the chain dead-ended at "open a new session manually".
// A session cannot replace itself (SYSTEM-CONTRACT §5): this helper is the outside hand, run
// DETACHED from the dying session so it survives it. The chain mirrors the app's proven
// handoff_now (lib.rs): idle-gate → graceful end → reopen → kickoff prompt over the socket.
//
//   node bin/baton-pane.mjs --project <dir> --handoff <file> [--pane <id>]
//
// Env seams (the drill's off switches, same doctrine as TRANTOR_NO_HANDOFF_SPAWN):
//   TRANTOR_BATON_IDLE_DEADLINE_S  give up waiting for idle after this many seconds (default 600)
//   TRANTOR_BATON_REOPEN           command to reopen the pane, instead of `trantor open`
//                                  (the drill points this at its own herdr world)
// Detached means nobody reads stdout: everything lands in <bus>/logs/baton-pane-<project>.log.
import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { execFileSync, execSync } from "node:child_process";
import { createConnection } from "node:net";

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : ""; };
const projectDir = arg("--project") || process.cwd();
const handoffFile = arg("--handoff");
const projectName = basename(projectDir);
const busDir = process.env.AGENT_BUS_DIR || process.env.RELAY_DATA_DIR || join(homedir(), ".agent-bus");

const logDir = join(busDir, "logs");
try { mkdirSync(logDir, { recursive: true }); } catch {}
const logFile = join(logDir, `baton-pane-${projectName}.log`);
const log = (s) => { try { appendFileSync(logFile, `${new Date().toISOString()} ${s}\n`); } catch {} };

// Same text as the app's kickoff (lib.rs KICKOFF_PROMPT) — one boot prompt so the successor
// recaps unprompted instead of sitting idle until a human types (the 15-minute silence, #5649).
const KICKOFF_PROMPT = "You have just taken over via handoff. Recap now per your instructions.";

// The pane, resolved exactly like the app does (orch_pane_from_rows): last orch row wins.
export function orchPane(rows, project) {
  let pane = null;
  for (const l of String(rows).split("\n")) {
    const f = l.split("\t");
    if (f[0] === project && f[1] === "orch" && f[3] && f[3].trim()) pane = f[3].trim();
  }
  return pane;
}

function herdrJson(args) {
  try { return JSON.parse(execFileSync("herdr", args, { encoding: "utf8", timeout: 15000 })); } catch { return null; }
}

/** One request over herdr's socket — byte-identical to the app's transport (herdr.rs). */
function socketRequest(req, timeoutMs = 30_000) {
  const sockPath = join(homedir(), ".config", "herdr", "herdr.sock");
  return new Promise((resolve, reject) => {
    const s = createConnection(sockPath);
    const t = setTimeout(() => { s.destroy(); reject(new Error("socket timeout")); }, timeoutMs);
    let buf = "";
    s.on("connect", () => s.write(JSON.stringify(req) + "\n"));
    s.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) { clearTimeout(t); s.destroy(); resolve(buf.slice(0, nl)); }
    });
    s.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const agentStatus = (pane) => herdrJson(["agent", "get", pane])?.result?.agent?.agent_status || null;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function main() {
  if (!handoffFile || !existsSync(handoffFile)) { log(`no handoff file (${handoffFile}) — abort`); process.exit(1); }
  const pane = arg("--pane") || orchPane((() => { try { return readFileSync(join(busDir, "crew-windows.txt"), "utf8"); } catch { return ""; } })(), projectName);
  if (!pane) { log(`no orch pane row for ${projectName} — abort (the window path should have run instead)`); process.exit(1); }
  log(`armed: pane=${pane} handoff=${basename(handoffFile)}`);

  // 1. Idle gate. The dying session invoked us MID-TURN (the skill's Bash call); ending it now
  //    would kill in-flight work — the exact failure #5645 exists to prevent. Wait for the turn
  //    boundary, with a deadline so a hung session doesn't pin this process forever.
  const deadline = Date.now() + (Number(process.env.TRANTOR_BATON_IDLE_DEADLINE_S) || 600) * 1000;
  let st;
  while ((st = agentStatus(pane)) === "working") {
    if (Date.now() > deadline) { log(`idle deadline passed (still ${st}) — giving up, handoff waits on disk`); process.exit(1); }
    await sleep(3000);
  }
  log(`idle gate passed (status=${st ?? "no agent"})`);

  // 2. Graceful end, mirroring end_process_gracefully: TERM, short wait, KILL.
  const info = herdrJson(["pane", "process-info", "--pane", pane])?.result?.process_info;
  const pid = Number(info?.foreground_process_group_id) || Number(info?.foreground_processes?.[0]?.pid) || 0;
  if (pid > 0 && alive(pid)) {
    try { process.kill(pid, "SIGTERM"); } catch {}
    const killAt = Date.now() + 10_000;
    while (alive(pid) && Date.now() < killAt) await sleep(200);
    if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    log(`ended pid ${pid}`);
  } else {
    log("no foreground process to end (already gone)");
  }

  // 3. Reopen. `trantor open` rebinds orch-sessions.txt and restarts the pane's session — the
  //    bookkeeping the classic seam regression comes from skipping. The drill overrides this to
  //    stay inside its own herdr world.
  const reopen = process.env.TRANTOR_BATON_REOPEN || "trantor open";
  try {
    execSync(reopen, { cwd: projectDir, encoding: "utf8", timeout: 120_000, stdio: "pipe" });
    log(`reopened via: ${reopen}`);
  } catch (e) {
    log(`reopen FAILED (${String(e?.message).slice(0, 200)}) — handoff waits on disk`);
    process.exit(1);
  }

  // 4. Kickoff — retry while the successor boots; a NotReady prompt would land on nobody.
  for (let i = 0; i < 20; i++) {
    if (agentStatus(pane) === "idle") break;
    await sleep(3000);
  }
  try {
    const raw = await socketRequest({ id: "trantor:agent.prompt", method: "agent.prompt", params: { target: pane, text: KICKOFF_PROMPT } });
    log(`kickoff: ${String(JSON.parse(raw).result?.type)}`);
  } catch (e) {
    log(`kickoff FAILED (${String(e?.message).slice(0, 120)}) — successor may sit idle until spoken to`);
  }
}

// Import-safe (the drill imports orchPane): only run as a script.
if (process.argv[1] && basename(process.argv[1]) === "baton-pane.mjs") {
  main().catch(e => { log(`crash: ${String(e?.stack || e).slice(0, 400)}`); process.exit(1); });
}

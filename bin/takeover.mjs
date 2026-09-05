#!/usr/bin/env node
// `trantor takeover` — one command from "the conversation lives in a Terminal window" to "it
// lives in the pane" (#5495, design: docs/DESIGN-takeover-visibility.md).
//
// The chain: inventory → idle gate → graceful end → adopt → open. CLI-first on purpose: the
// app's button shells THIS command (takeover_now), so the terminal user and the button share one
// tested implementation — the handoff_now pattern.
//
// What this must never do, from the design:
// - never end a session that wrote its transcript seconds ago without --force (in-flight work);
// - never pick silently between two live candidates (refuse and show both; --session decides);
// - never leave the operator with nothing: if open fails after the terminal claude exited, print
//   the exact `claude --resume <sid>` that recovers the thread by hand.
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { resolveProject } from "../lib/project.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const JSON_OUT = flag("--json");
const stages = [];
const say = (s) => { stages.push(s); if (!JSON_OUT) console.log(s); };
const out = (ok, extra = {}) => {
  if (JSON_OUT) console.log(JSON.stringify({ ok, stages, ...extra }));
  process.exit(ok ? 0 : 2);
};

const project = args.find(a => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--session")
  || resolveProject(process.cwd());
const devRoot = process.env.TRANTOR_DEV_ROOT || join(homedir(), "development");
const dir = join(devRoot, project);
if (!existsSync(dir)) { say(`no local checkout for ${project} (looked in ${devRoot})`); out(false, { reason: "no-checkout" }); }

// The idle gate: a transcript written this recently means the session is MID-TURN, and ending it
// would eat in-flight work. Overridable for drills and deliberate --force.
export const IDLE_GATE_SEC = Number(process.env.TRANTOR_TAKEOVER_IDLE_SEC || 15);

/** The decision table, pure so it can be drilled without processes (test-takeover.mjs). */
export function decide({ terminalPids, candidates, sessionFlag, force, idleGateSec = IDLE_GATE_SEC }) {
  if (!terminalPids.length) return { action: "open", reason: "no terminal session — plain open (start or reopen the pane)" };
  if (terminalPids.length > 1) {
    return { action: "refuse", reason: `${terminalPids.length} claude sessions run in this directory (pids ${terminalPids.join(", ")}) — close the extras first; a takeover must know which conversation it is adopting` };
  }
  if (!candidates.length) return { action: "refuse", reason: "a claude runs here but no transcript has been written in the last hour — nothing safe to adopt" };
  const chosen = sessionFlag ? candidates.find(c => c.id === sessionFlag) : candidates[0];
  if (sessionFlag && !chosen) return { action: "refuse", reason: `${sessionFlag} is not among the recent transcripts here` };
  if (!sessionFlag && candidates.length > 1) {
    const list = candidates.slice(0, 4).map(c => `${c.id} (${c.ageSec}s ago)`).join(" · ");
    return { action: "refuse", reason: `two live conversations here — pick one with --session <id>: ${list}` };
  }
  if (chosen.ageSec < idleGateSec && !force) {
    return { action: "refuse", reason: `looks MID-TURN (transcript written ${chosen.ageSec}s ago, gate ${idleGateSec}s) — wait for the turn to finish, or --force` };
  }
  return { action: "takeover", sid: chosen.id, pid: terminalPids[0] };
}

// ---- inventory (process + filesystem truth only) ----------------------------------------------
function paneForegroundPgid() {
  try {
    const rows = execFileSync("cat", [join(process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus"), "crew-windows.txt")], { encoding: "utf8" });
    const pane = rows.split("\n").map(l => l.split("\t")).find(f => f[0] === project && f[1] === "orch")?.[3];
    if (!pane) return 0;
    const info = execFileSync("herdr", ["pane", "process-info", "--pane", pane], { encoding: "utf8", timeout: 6000 });
    return Number(JSON.parse(info.slice(info.search(/[[{]/)))?.result?.process_info?.foreground_process_group_id) || 0;
  } catch { return 0; }
}

function terminalClaudePids() {
  let pids = [];
  try { pids = execFileSync("/usr/bin/pgrep", ["-x", "claude"], { encoding: "utf8" }).split("\n").filter(Boolean); } catch { return []; }
  const panePgid = paneForegroundPgid();
  const mine = [];
  for (const pid of pids) {
    if (Number(pid) === panePgid) continue;   // the pane's own claude is not a "terminal session"
    try {
      const cwd = execFileSync("/usr/sbin/lsof", ["-a", "-d", "cwd", "-p", pid, "-Fn"], { encoding: "utf8" })
        .split("\n").find(l => l.startsWith("n"))?.slice(1);
      if (cwd === dir) mine.push(Number(pid));
    } catch { /* raced away */ }
  }
  return mine;
}

function recentCandidates() {
  const slug = dir.replace(/[/.]/g, "-");
  const tdir = join(process.env.TRANTOR_CLAUDE_DIR || join(homedir(), ".claude", "projects"), slug);
  if (!existsSync(tdir)) return [];
  const now = Date.now();
  return readdirSync(tdir).filter(f => f.endsWith(".jsonl"))
    .map(f => { const st = statSync(join(tdir, f)); return { id: f.replace(/\.jsonl$/, ""), ageSec: Math.round((now - st.mtimeMs) / 1000) }; })
    .filter(c => c.ageSec < 3600)
    .sort((a, b) => a.ageSec - b.ageSec);
}

// ---- the chain --------------------------------------------------------------------------------
// Run the chain ONLY when this file is the entrypoint. The first cut used
// argv[1].endsWith("takeover.mjs"), which is also true for test-takeover.mjs — importing the
// decision table from the drill file executed a real (luckily idempotent) pane open.
import { basename as _bn } from "node:path";
if (process.argv[1] && _bn(process.argv[1]) === "takeover.mjs") {
  const d = decide({ terminalPids: terminalClaudePids(), candidates: recentCandidates(), sessionFlag: opt("--session"), force: flag("--force") });
  if (flag("--dry-run")) { say(`dry-run: ${d.action}${d.reason ? ` — ${d.reason}` : ""}${d.sid ? ` (sid ${d.sid}, pid ${d.pid})` : ""}`); out(true, { decision: d }); }
  if (d.action === "refuse") { say(d.reason); out(false, { reason: d.reason }); }

  if (d.action === "takeover") {
    say(`ending Terminal session pid ${d.pid} (idle ${IDLE_GATE_SEC}s gate passed)`);
    try { process.kill(d.pid, "SIGTERM"); } catch {}
    const deadline = Date.now() + 8000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try { process.kill(d.pid, 0); spawnSync("sleep", ["0.3"]); } catch { alive = false; }
    }
    if (alive) { try { process.kill(d.pid, "SIGKILL"); } catch {} say("did not exit in 8s — killed"); }
    else say("session ended cleanly");

    const adopt = spawnSync(process.execPath, [join(HERE, "adopt.mjs"), project, "--session", d.sid], { encoding: "utf8", timeout: 20000 });
    if (adopt.status !== 0) { say(`adopt failed: ${(adopt.stderr || adopt.stdout || "").trim().slice(0, 200)}`); out(false, { reason: "adopt-failed", sid: d.sid }); }
    say(`adopted ${d.sid} as ${project}'s orchestrator thread`);
  }

  const open = spawnSync(process.execPath, [join(HERE, "crew.mjs"), "open", project], { cwd: dir, encoding: "utf8", timeout: 120000 });
  if (open.status !== 0) {
    say(`open failed: ${(open.stderr || "").trim().slice(0, 200)}`);
    if (d.sid) say(`the conversation is safe on disk — recover by hand: claude --resume ${d.sid}`);
    out(false, { reason: "open-failed", sid: d.sid || null });
  }
  say(`pane hosted: ${(open.stdout || "").trim().split("\n").pop()}`);
  out(true, { sid: d.sid || null });
}

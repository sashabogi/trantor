// trantor/kimi — handoff core for Kimi Code sessions. Port of hooks/lib/handoff.mjs with the
// Claude transcript replaced by Kimi's wire.jsonl and the fresh-session spawn targeting `kimi`.
//
// Kimi Code session layout (discovered, v0.28):
//   ~/.kimi-code/sessions/wd_<projectBasename>_<hash>/<ses|session>_<uuid>/
//     state.json                     { workDir, agents: { main: { homedir }, … } }
//     agents/main/wire.jsonl         the session transcript (append-only event log)
//     agents/<subagent>/wire.jsonl   sub-agent transcripts (siblings of main)
//
// wire.jsonl event shapes that matter here:
//   {type:"turn.prompt", input:[{type:"text",text}], time}              — a user turn
//   {type:"context.append_message", message:{role,content:[{type:"text",text}]}}
//   {type:"context.append_loop_event", event:{type:"content.part", part:{type:"text"|"think", …}}, time}
//   {type:"usage.record", model, usage:{inputOther,output,inputCacheRead,inputCacheCreation}, time}
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir, hostname } from "node:os";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const HANDOFF_DIR = join(process.env.RELAY_DATA_DIR || join(homedir(), ".agent-bus"), "handoffs");
const HERE = dirname(fileURLToPath(import.meta.url));            // <plugin>/kimi/hooks/lib
const KIMI_BIN = join(HERE, "..", "..", "bin");                  // <plugin>/kimi/bin

export function readConfig() {
  try {
    const cfg = join(homedir(), ".agent-bus", "config.json");
    return existsSync(cfg) ? JSON.parse(readFileSync(cfg, "utf8")) : {};
  } catch { return {}; }
}

export function relayUrl(conf = readConfig()) {
  return process.env.RELAY_URL || conf.url || "http://127.0.0.1:4477";
}

function nowSec() { try { return Number(execSync("date +%s", { encoding: "utf8" }).trim()) || 0; } catch { return 0; } }

// ---- wire.jsonl discovery ---------------------------------------------------
// The hook payload's session_id matches the session directory name on current Kimi Code
// (session_<uuid>); fall back to the newest wire.jsonl for this project when it doesn't.
export function findWire(projectDir, sessionId = "") {
  try {
    const base = join(homedir(), ".kimi-code", "sessions");
    const prefix = `wd_${basename(projectDir)}_`;
    const wdDirs = readdirSync(base).filter(d => d.startsWith(prefix));
    let best = "", bestM = 0;
    for (const wd of wdDirs) {
      const wdp = join(base, wd);
      // Preferred: the exact session directory named by the hook payload.
      if (sessionId) {
        const exact = join(wdp, sessionId, "agents", "main", "wire.jsonl");
        if (existsSync(exact)) return exact;
      }
      for (const ses of readdirSync(wdp)) {
        const w = join(wdp, ses, "agents", "main", "wire.jsonl");
        try { const m = statSync(w).mtimeMs; if (m > bestM) { best = w; bestM = m; } } catch {}
      }
    }
    return best;
  } catch { return ""; }
}

// Parse one wire.jsonl into normalized records — tolerant: unknown event types are skipped.
function parseWire(wirePath) {
  const rows = [];
  try {
    for (const line of readFileSync(wirePath, "utf8").split("\n")) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      rows.push(r);
    }
  } catch {}
  return rows;
}

// ---- context occupancy ------------------------------------------------------
// Latest usage.record (or step.end usage) wins. Current context tokens ≈
// inputOther + inputCacheRead + inputCacheCreation (cached prompt IS part of the window).
export function contextUsage(wirePath, conf = readConfig()) {
  if (!wirePath || !existsSync(wirePath)) return null;
  let buf = "";
  try {
    const fd = openSync(wirePath, "r");
    try {
      const size = fstatSync(fd).size;
      const tail = Math.min(size, 1_500_000);
      const b = Buffer.alloc(tail);
      readSync(fd, b, 0, tail, size - tail);
      buf = b.toString("utf8");
    } finally { closeSync(fd); }
  } catch { return null; }

  const lines = buf.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let r; try { r = JSON.parse(lines[i]); } catch { continue; }
    let u = null, model = "";
    if (r?.type === "usage.record" && r.usage) { u = r.usage; model = r.model || ""; }
    else if (r?.type === "context.append_loop_event" && r.event?.type === "step.end" && r.event.usage) { u = r.event.usage; }
    if (!u) continue;
    const tokens = (u.inputOther || 0) + (u.inputCacheRead || 0) + (u.inputCacheCreation || 0);
    if (tokens <= 0) continue;
    const window = resolveWindow(model, conf);
    return { tokens, window, frac: window ? tokens / window : null, model };
  }
  return null;
}

// The wire doesn't encode the model's context-window size, so (exactly like the Claude port)
// the proactive early-warning only arms when the window is declared: env RELAY_CONTEXT_WINDOW
// or config.contextWindow. Returns 0 when unknown (→ no warning; PreCompact is the backstop).
export function resolveWindow(model = "", conf = readConfig()) {
  const explicit = Number(process.env.RELAY_CONTEXT_WINDOW || conf.contextWindow || 0);
  if (explicit > 0) return explicit;
  if (/\[1m\]|-1m\b|:1m\b/i.test(model)) return 1_000_000;
  return 0;
}

export function warnFrac(conf = readConfig()) {
  const f = Number(process.env.RELAY_CONTEXT_WARN_FRAC || conf.contextWarnFrac || 0.90);
  return f > 0 && f < 1 ? f : 0.90;
}

// ---- per-session guard ------------------------------------------------------
function guardPath(sessionId) {
  const safe = String(sessionId || "nosession").replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(homedir(), ".agent-bus", `handoff-fired-${safe}.json`);
}
export function alreadyHandedOff(sessionId, curTokens = 0) {
  try {
    const p = guardPath(sessionId);
    if (!existsSync(p)) return false;
    const g = JSON.parse(readFileSync(p, "utf8"));
    if (curTokens && g.atTokens && curTokens < g.atTokens * 0.7) return false;
    return true;
  } catch { return false; }
}
export function markHandedOff(sessionId, curTokens = 0) {
  try {
    if (!existsSync(dirname(guardPath(sessionId)))) mkdirSync(dirname(guardPath(sessionId)), { recursive: true });
    writeFileSync(guardPath(sessionId), JSON.stringify({ at: nowSec(), atTokens: curTokens || 0 }));
  } catch {}
}

// ---- in-flight guard --------------------------------------------------------
// True when this session has live sub-agents: any agents/<not-main>/wire.jsonl written within
// `withinMs`. The auto baton-pass DEFERS while sub-agents run (incident 2026-06-21).
export function subagentsActive(wirePath, withinMs = 90_000) {
  try {
    if (!wirePath) return false;
    const agentsDir = dirname(dirname(wirePath));       // <session>/agents
    const cutoff = Date.now() - withinMs;
    for (const a of readdirSync(agentsDir)) {
      if (a === "main") continue;
      try { if (statSync(join(agentsDir, a, "wire.jsonl")).mtimeMs >= cutoff) return true; } catch {}
    }
    return false;
  } catch { return false; }
}

// ---- whole-session summary --------------------------------------------------
function collectTurns(wirePath) {
  const turns = [];
  for (const r of parseWire(wirePath)) {
    if (r.type === "turn.prompt") {
      const text = (Array.isArray(r.input) ? r.input : [])
        .map(p => (p && typeof p === "object" && typeof p.text === "string") ? p.text : "")
        .filter(Boolean).join("\n").trim();
      if (text) turns.push(`### USER\n${text.slice(0, 2400)}`);
    } else if (r.type === "context.append_message" && r.message) {
      const role = r.message.role || "user";
      if (role !== "user" && role !== "assistant") continue;
      const c = r.message.content;
      const text = (typeof c === "string" ? c : Array.isArray(c)
        ? c.filter(b => b?.type === "text").map(b => b.text).join("\n") : "").trim();
      if (!text || text.startsWith("<task-notification") || text.startsWith("<command")) continue;
      turns.push(`### ${role.toUpperCase()}\n${text.slice(0, 2400)}`);
    } else if (r.type === "context.append_loop_event" && r.event?.type === "content.part") {
      const p = r.event.part || {};
      if (p.type !== "text" || !p.text) continue;      // visible reply text only, never think blocks
      turns.push(`### ASSISTANT\n${String(p.text).trim().slice(0, 2400)}`);
    }
  }
  return turns;
}

function digest(turns, budget = 56_000) {
  const joined = turns.join("\n\n");
  if (joined.length <= budget) return joined;

  const headN = Math.min(6, turns.length);
  const tailN = Math.min(24, Math.max(0, turns.length - headN));
  const head = turns.slice(0, headN);
  const tail = turns.slice(turns.length - tailN);
  const midPool = turns.slice(headN, turns.length - tailN);

  const midKeep = 18;
  const mid = [];
  if (midPool.length > 0) {
    const step = Math.max(1, Math.floor(midPool.length / midKeep));
    for (let i = 0; i < midPool.length && mid.length < midKeep; i += step) mid.push(midPool[i]);
  }
  let out = [
    ...head,
    midPool.length ? "### … (mid-session, evenly sampled) …" : "",
    ...mid,
    tail.length ? "### … (recent) …" : "",
    ...tail,
  ].filter(Boolean).join("\n\n");
  if (out.length > budget) out = out.slice(out.length - budget);
  return out;
}

function haveScrooge() {
  if (process.env.TRANTOR_NO_SCROOGE === "1") return false;
  try { execSync("command -v scrooge", { stdio: "ignore" }); return true; } catch { return false; }
}

export function buildSummary(wirePath) {
  if (!wirePath || !existsSync(wirePath)) return "*(no transcript available to summarize)*";
  let convo = "";
  try { convo = digest(collectTurns(wirePath)); } catch { convo = ""; }
  if (!convo) return "*(transcript unreadable)*";
  const sys = "You are writing a SESSION HANDOFF so a fresh Kimi Code session can take over without losing context. The text spans an entire (possibly multi-hour) session: opening turns, an even sample of the middle, and the recent tail. Produce a concise but COMPLETE markdown handoff with these sections: TASK (what we're doing + the goal), STATE (done / in-progress), KEY DECISIONS, OPEN THREADS & NEXT STEPS (concrete actions), KEY FILES & locations (exact paths). Be specific. Cover the whole arc, not just the end. Do not pad.";
  if (haveScrooge()) {
    try {
      return execSync(`scrooge -t summarize -d medium --system ${JSON.stringify(sys)}`, {
        input: convo, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
      }).trim() || `*(empty summary — raw recent tail)*\n\n${convo.slice(-8000)}`;
    } catch (e) { process.stderr.write(`[trantor] scrooge summarize failed: ${e?.message}\n`); }
  }
  return `*(no summarizer available — representative transcript digest)*\n\n${convo.slice(-12000)}`;
}

export function verbatimRecentTail(wirePath, chars = 7000) {
  try { return collectTurns(wirePath).join("\n\n").slice(-chars); } catch { return ""; }
}

// ---- write + announce + spawn ----------------------------------------------
export function writeHandoff({ projectDir, sessionId, transcript, trigger, summary, force = false }) {
  const projectName = basename(projectDir);
  // Server-side storm guard (see hooks/lib/handoff.mjs) — non-forced handoffs inside the hub's
  // cooldown are skipped. Fail-OPEN when the hub is unreachable.
  if (!force) {
    try {
      const body = JSON.stringify({ project: projectName, session: sessionId || "", trigger: trigger || "auto" });
      const out = execSync(`curl -s --max-time 2 -X POST -H 'content-type: application/json' -d ${JSON.stringify(body)} ${JSON.stringify(relayUrl() + "/handoff")}`, { encoding: "utf8", timeout: 2500 });
      const r = JSON.parse(out);
      if (r && r.allow === false) return { skipped: true, reason: r.reason || "storm-guard", sinceSec: r.sinceSec };
    } catch {}
  }
  if (!existsSync(HANDOFF_DIR)) mkdirSync(HANDOFF_DIR, { recursive: true });
  const stamp = nowSec() || Date.now();
  let gitStatus = "";
  try { gitStatus = execSync("git -C " + JSON.stringify(projectDir) + " status --short 2>/dev/null | head -30", { encoding: "utf8" }).trim(); } catch {}
  const wire = transcript || findWire(projectDir, sessionId);
  const narrative = summary ?? buildSummary(wire);
  const tail = verbatimRecentTail(wire);
  // Kimi sub-agent manifest: not derived yet (wire format for sub-agents is new) — the successor
  // can list this session's agents from the wire dir; kept null here rather than a fake snapshot.
  const subagents = null;
  let verifyGates = [];
  try {
    const out = execSync(`curl -s --max-time 2 ${JSON.stringify(relayUrl() + "/verify-gates?project=" + encodeURIComponent(projectName))}`, { encoding: "utf8", timeout: 2500 });
    verifyGates = JSON.parse(out).gates || [];
  } catch {}
  const record = {
    id: `${projectName}-${stamp}`,
    project: projectDir, projectName, machine: hostname(),
    agent: "kimi",
    session_id: sessionId || "", trigger: trigger || "auto",
    transcript_path: wire || "", stamp: Number(stamp) || 0,
    summary: narrative + (tail ? `\n\n---\n## Verbatim recent exchange (exact in-flight state — continue from here)\n${tail}` : ""),
    gitStatus, subagents, verifyGates, consumed: false,
  };
  const file = join(HANDOFF_DIR, `${record.id}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));
  supersedeOlderHandoffs(projectName, record.id);
  return { file, record };
}

export function supersedeOlderHandoffs(projectName, keepId) {
  try {
    if (!existsSync(HANDOFF_DIR)) return;
    const re = new RegExp("^" + String(projectName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-(\\d+)\\.json$");
    for (const f of readdirSync(HANDOFF_DIR)) {
      if (!re.test(f)) continue;
      const p = join(HANDOFF_DIR, f);
      try {
        const rec = JSON.parse(readFileSync(p, "utf8"));
        if (rec.id === keepId || rec.consumed) continue;
        rec.consumed = true; rec.superseded = true; rec.supersededBy = keepId;
        writeFileSync(p, JSON.stringify(rec, null, 2));
      } catch {}
    }
  } catch {}
}

// --- baton pass: the original session's Terminal window (macOS) --------------
export function controllingTty() {
  for (const pid of [process.pid, process.ppid, getPpid(process.ppid)]) {
    if (!pid) continue;
    try { const t = execSync(`ps -o tty= -p ${pid}`, { encoding: "utf8" }).trim(); if (t && t !== "??" && t !== "?") return "/dev/" + t; } catch {}
  }
  return "";
}
function getPpid(pid) { if (!pid) return 0; try { return Number(execSync(`ps -o ppid= -p ${pid}`, { encoding: "utf8" }).trim()) || 0; } catch { return 0; } }

export function terminalWindowForTty(tty) {
  if (process.platform !== "darwin" || !tty) return "";
  const osa = `tell application "Terminal"
    repeat with w in windows
      try
        if (tty of selected tab of w) is "${tty}" then return (id of w) as string
      end try
    end repeat
    return ""
  end tell`;
  try { return execSync(`osascript`, { input: osa, encoding: "utf8", timeout: 3000 }).trim(); } catch { return ""; }
}

// Arm the baton-close watcher (kimi variant — see kimi/bin/baton-close.mjs). Same safety
// contract: auto-close strictly opt-in (config.autoCloseOriginal:true); manual baton closes.
export function armBatonClose(handoffFile, originalWindowId, originalTty, conf = readConfig(), { auto = false } = {}) {
  try {
    if (process.platform !== "darwin" || !originalWindowId) return false;
    if (process.env.TRANTOR_NO_BATON_CLOSE === "1" || conf.batonClose === false) return false;
    if (auto && conf.autoCloseOriginal !== true) return false;
    const closer = join(KIMI_BIN, "baton-close.mjs");
    if (!existsSync(closer)) return false;
    const child = spawn(process.execPath, [closer, handoffFile, String(originalWindowId), originalTty || ""], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch { return false; }
}

export async function pingBus(projectName, id, conf = readConfig()) {
  try {
    await fetch(`${relayUrl(conf)}/send`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: `${hostname()}:${projectName}`, to: "all",
        text: `📋 Handoff ready for ${projectName} — open a fresh session here to take over (id ${id}).` }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  } catch {}
}

// The fresh-session command. Kimi Code has no positional-prompt interactive mode (-p is
// non-interactive and exits), so the baton opens a plain interactive `kimi`: the SessionStart
// hook claims the pending handoff and injects it into context, and the user drives from there
// ("recap" or any first prompt resumes the work).
export const RECAP_CMD = "kimi";

export function maybeSpawn(projectDir, conf = readConfig()) {
  try {
    if (process.platform !== "darwin") return false;
    if (process.env.TRANTOR_NO_HANDOFF_SPAWN === "1") return false;
    if (conf.autoHandoffPrompt === false) return false;
    const script = join(KIMI_BIN, "handoff-prompt.sh");
    if (!existsSync(script)) { process.stderr.write(`[trantor] kimi handoff-prompt.sh missing\n`); return false; }
    const timeout = String(conf.handoffPromptTimeout || 25);
    const child = spawn("/bin/bash", [script, projectDir, timeout], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch (e) { process.stderr.write(`[trantor] maybeSpawn error: ${e?.message}\n`); return false; }
}

export function spawnFresh(projectDir) {
  try {
    if (process.platform !== "darwin" || process.env.TRANTOR_NO_HANDOFF_SPAWN === "1") return false;
    const script = join(KIMI_BIN, "open-session.sh");
    if (!existsSync(script)) return false;
    const child = spawn("/bin/bash", [script, projectDir, RECAP_CMD], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch { return false; }
}

export function frontTerminalWindow() {
  if (process.platform !== "darwin") return { id: "", tty: "" };
  try {
    const out = execSync(`osascript -e ${JSON.stringify(`tell application "Terminal" to return (id of front window as string) & "|" & (tty of selected tab of front window)`)}`,
      { encoding: "utf8", timeout: 3000 }).trim();
    const [id, tty] = out.split("|"); return { id: id || "", tty: tty || "" };
  } catch { return { id: "", tty: "" }; }
}

export function resolveOriginalWindow() {
  let tty = controllingTty(), windowId = tty ? terminalWindowForTty(tty) : "";
  if (!windowId) { const f = frontTerminalWindow(); windowId = f.id; tty = f.tty; }
  return { windowId, tty };
}

// MANUAL one-command baton (ordering is load-bearing — see hooks/lib/handoff.mjs).
export function spawnBaton({ projectDir, handoffFile, conf = readConfig(),
  _resolveWindow = resolveOriginalWindow, _spawnFresh = spawnFresh, _armClose = armBatonClose }) {
  const { windowId, tty } = _resolveWindow();
  const spawned = _spawnFresh(projectDir);
  if (!spawned) return { spawned: false, armed: false, windowId: "" };
  const armed = windowId ? _armClose(handoffFile, windowId, tty, conf) : false;
  return { spawned, armed, windowId };
}

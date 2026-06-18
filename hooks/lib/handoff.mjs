// trantor handoff core — shared by the PreCompact hook (at-the-wall) and the
// PostToolUse heartbeat (proactive early-warning). One place that knows how to:
//   • read a session's live context occupancy from its transcript usage,
//   • build a WHOLE-SESSION summary (not just the tail),
//   • write a handoff record, and
//   • spawn a fresh same-agent session in a new terminal that takes it over.
//
// Why this exists: PreCompact fires only at the compaction wall and cannot stop
// compaction, so the only way to continue with a full window is to open a NEW
// session that loads the handoff. The heartbeat path lets us do that BEFORE the
// wall when we know the window size. Both paths share a per-session guard so we
// never write/spawn twice for the same context window.
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir, hostname } from "node:os";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const HANDOFF_DIR = join(process.env.RELAY_DATA_DIR || join(homedir(), ".agent-bus"), "handoffs");
const HERE = dirname(fileURLToPath(import.meta.url));

export function readConfig() {
  try {
    const cfg = join(homedir(), ".agent-bus", "config.json");
    return existsSync(cfg) ? JSON.parse(readFileSync(cfg, "utf8")) : {};
  } catch { return {}; }
}

export function relayUrl(conf = readConfig()) {
  return process.env.RELAY_URL || conf.url || "http://127.0.0.1:4477";
}

// ---- context occupancy ------------------------------------------------------
// Read only the tail of the (potentially huge, append-only) transcript and find
// the most recent assistant turn's usage. Current context tokens ≈ input +
// cache_read + cache_creation (the cached prompt IS part of the window).
export function contextUsage(transcriptPath, conf = readConfig()) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  let buf = "";
  try {
    const fd = openSync(transcriptPath, "r");
    try {
      const size = fstatSync(fd).size;
      const tail = Math.min(size, 1_500_000); // last ~1.5MB is plenty for recent turns
      const b = Buffer.alloc(tail);
      readSync(fd, b, 0, tail, size - tail);
      buf = b.toString("utf8");
    } finally { closeSync(fd); }
  } catch { return null; }

  const lines = buf.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let r; try { r = JSON.parse(lines[i]); } catch { continue; }
    const u = r?.message?.usage;
    if (r?.type === "assistant" && u) {
      const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (tokens <= 0) continue;
      const model = r.message.model || "";
      const window = resolveWindow(model, conf);
      return { tokens, window, frac: window ? tokens / window : null, model };
    }
  }
  return null;
}

// The transcript logs the model WITHOUT the [1m] marker, so we cannot tell a
// 200k window from a 1M one. There is therefore no safe universal default — the
// window must be declared (env RELAY_CONTEXT_WINDOW or config.contextWindow) for
// the proactive early-warning to activate. Returns 0 when unknown (→ no warning).
export function resolveWindow(model = "", conf = readConfig()) {
  const explicit = Number(process.env.RELAY_CONTEXT_WINDOW || conf.contextWindow || 0);
  if (explicit > 0) return explicit;
  if (/\[1m\]|-1m\b|:1m\b/i.test(model)) return 1_000_000; // honored if ever present
  return 0;
}

export function warnFrac(conf = readConfig()) {
  const f = Number(process.env.RELAY_CONTEXT_WARN_FRAC || conf.contextWarnFrac || 0.90);
  return f > 0 && f < 1 ? f : 0.90;   // baton pass fires at 90% — runway to summarize + hand off before the wall
}

// ---- per-session guard (shared by both paths) -------------------------------
// One handoff+spawn per context window. Re-arms after a compaction resets the
// context (tokens drop well below where we fired).
function guardPath(sessionId) {
  const safe = String(sessionId || "nosession").replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(homedir(), ".agent-bus", `handoff-fired-${safe}.json`);
}
export function alreadyHandedOff(sessionId, curTokens = 0) {
  try {
    const p = guardPath(sessionId);
    if (!existsSync(p)) return false;
    const g = JSON.parse(readFileSync(p, "utf8"));
    // Re-arm if context clearly reset (e.g. after a compaction) — well below the fire point.
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

function nowSec() { try { return Number(execSync("date +%s", { encoding: "utf8" }).trim()) || 0; } catch { return 0; } }

// ---- whole-session summary --------------------------------------------------
function collectTurns(transcriptPath) {
  const rows = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const turns = [];
  for (const r of rows) {
    if (!(r.type === "user" || r.type === "assistant") || !r.message) continue;
    const c = r.message.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) text = c.filter(b => b?.type === "text").map(b => b.text).join("\n");
    text = (text || "").trim();
    if (!text || text.startsWith("<task-notification") || text.startsWith("<command")) continue;
    turns.push(`### ${r.type.toUpperCase()}\n${text.slice(0, 2400)}`);
  }
  return turns;
}

// Build a digest that spans the WHOLE session: the opening turns (the task &
// goal framing), an even sample of the middle (the arc of the work), and a
// fuller recent tail (current state). The old hook kept only the last 16KB —
// on a multi-hour session that captured only the final moments.
function digest(turns, budget = 56_000) {
  const joined = turns.join("\n\n");
  if (joined.length <= budget) return joined;

  const headN = Math.min(6, turns.length);
  const tailN = Math.min(24, Math.max(0, turns.length - headN));
  const head = turns.slice(0, headN);
  const tail = turns.slice(turns.length - tailN);
  const midPool = turns.slice(headN, turns.length - tailN);

  // Evenly sample the middle so the summarizer sees the whole trajectory.
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
  if (out.length > budget) out = out.slice(out.length - budget); // never blow the budget
  return out;
}

function haveScrooge() {
  if (process.env.TRANTOR_NO_SCROOGE === "1") return false; // opt out (tests / no-LLM summary)
  try { execSync("command -v scrooge", { stdio: "ignore" }); return true; } catch { return false; }
}

export function buildSummary(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return "*(no transcript available to summarize)*";
  let convo = "";
  try { convo = digest(collectTurns(transcriptPath)); } catch { convo = ""; }
  if (!convo) return "*(transcript unreadable)*";
  const sys = "You are writing a SESSION HANDOFF so a fresh Claude Code session can take over without losing context. The text spans an entire (possibly multi-hour) session: opening turns, an even sample of the middle, and the recent tail. Produce a concise but COMPLETE markdown handoff with these sections: TASK (what we're doing + the goal), STATE (done / in-progress), KEY DECISIONS, OPEN THREADS & NEXT STEPS (concrete actions), KEY FILES & locations (exact paths). Be specific. Cover the whole arc, not just the end. Do not pad.";
  if (haveScrooge()) {
    try {
      return execSync(`scrooge -t summarize -d medium --system ${JSON.stringify(sys)}`, {
        input: convo, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
      }).trim() || `*(empty summary — raw recent tail)*\n\n${convo.slice(-8000)}`;
    } catch (e) { process.stderr.write(`[trantor] scrooge summarize failed: ${e?.message}\n`); }
  }
  return `*(no summarizer available — representative transcript digest)*\n\n${convo.slice(-12000)}`;
}

// The exact recent exchange, VERBATIM (not summarized/sampled) — so a baton-pass handoff carries the
// precise in-flight state (e.g. the live cs_live_… URL, the exact decision point) even if the scrooge
// narrative times out on a huge transcript. This is what lets the fresh session truly continue, not guess.
export function verbatimRecentTail(transcript, chars = 7000) {
  try { return collectTurns(transcript).join("\n\n").slice(-chars); } catch { return ""; }
}

// ---- write + announce + spawn ----------------------------------------------
export function writeHandoff({ projectDir, sessionId, transcript, trigger, summary }) {
  const projectName = basename(projectDir);
  if (!existsSync(HANDOFF_DIR)) mkdirSync(HANDOFF_DIR, { recursive: true });
  const stamp = nowSec() || Date.now();
  let gitStatus = "";
  try { gitStatus = execSync("git -C " + JSON.stringify(projectDir) + " status --short 2>/dev/null | head -30", { encoding: "utf8" }).trim(); } catch {}
  const narrative = summary ?? buildSummary(transcript);
  const tail = verbatimRecentTail(transcript);
  const record = {
    id: `${projectName}-${stamp}`,
    project: projectDir, projectName, machine: hostname(),
    session_id: sessionId || "", trigger: trigger || "auto",
    transcript_path: transcript || "", stamp: Number(stamp) || 0,
    // narrative + a verbatim recent-exchange block so exact in-flight state always survives
    summary: narrative + (tail ? `\n\n---\n## Verbatim recent exchange (exact in-flight state — continue from here)\n${tail}` : ""),
    gitStatus, consumed: false,
  };
  const file = join(HANDOFF_DIR, `${record.id}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));
  return { file, record };
}

// --- baton pass: the original session's Terminal window (macOS), so the fresh session can replace it ---
// Walk the process tree to the controlling tty (the hook itself may show "??" but its parent claude
// owns the Terminal's tty). Returns "/dev/ttysNNN" or "".
export function controllingTty() {
  for (const pid of [process.pid, process.ppid, getPpid(process.ppid)]) {
    if (!pid) continue;
    try { const t = execSync(`ps -o tty= -p ${pid}`, { encoding: "utf8" }).trim(); if (t && t !== "??" && t !== "?") return "/dev/" + t; } catch {}
  }
  return "";
}
function getPpid(pid) { if (!pid) return 0; try { return Number(execSync(`ps -o ppid= -p ${pid}`, { encoding: "utf8" }).trim()) || 0; } catch { return 0; } }

// Find the Terminal.app window id whose selected tab is on `tty` — the window to close on takeover.
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
  // Pass the MULTI-LINE script via stdin, NOT `-e ${JSON.stringify(osa)}`: a single -e arg keeps the
  // newlines as literal "\n" (JSON escapes them, the shell's double-quotes don't expand them), so
  // osascript saw `…"Terminal"\n  repeat…` and died with "27:28: Expected end of line but found unknown
  // token". stdin gives it real newlines. (This silently returned "" for years → callers always fell
  // through to frontTerminalWindow, which after a spawn grabs the WRONG window.)
  try { return execSync(`osascript`, { input: osa, encoding: "utf8", timeout: 3000 }).trim(); } catch { return ""; }
}

// Arm the baton-close watcher: a DETACHED process that waits until the fresh session consumes the
// handoff (consumed:true), then closes the original Terminal window. Never closes blind: aborts on
// timeout (fresh never showed) and re-validates the window's tty before closing.
export function armBatonClose(handoffFile, originalWindowId, originalTty, conf = readConfig()) {
  try {
    if (process.platform !== "darwin" || !originalWindowId) return false;
    if (process.env.TRANTOR_NO_BATON_CLOSE === "1" || conf.batonClose === false) return false;
    const closer = join(HERE, "..", "..", "bin", "baton-close.mjs");
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

// Spawn a fresh same-agent session (macOS) that takes over via the handoff.
// Default = ON (prompt with a timeout, default button "Open fresh session").
// Disable with config.autoHandoffPrompt:false or env TRANTOR_NO_HANDOFF_SPAWN=1.
export function maybeSpawn(projectDir, conf = readConfig()) {
  try {
    if (process.platform !== "darwin") return false;
    if (process.env.TRANTOR_NO_HANDOFF_SPAWN === "1") return false;
    if (conf.autoHandoffPrompt === false) return false;
    const script = join(HERE, "..", "..", "bin", "handoff-prompt.sh");
    if (!existsSync(script)) { process.stderr.write(`[trantor] handoff-prompt.sh missing\n`); return false; }
    const timeout = String(conf.handoffPromptTimeout || 25);
    const child = spawn("/bin/bash", [script, projectDir, timeout], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch (e) { process.stderr.write(`[trantor] maybeSpawn error: ${e?.message}\n`); return false; }
}

// The self-announcing fresh session command (single-quoted so it survives osascript→shell un-escaped).
export const RECAP_CMD = "claude 'Recap the handoff you just took over — what was the previous session doing, and where do we continue? Then wait for me.'";

// Spawn a fresh self-announcing session WITHOUT the dialog (manual handoff — the user already decided).
export function spawnFresh(projectDir) {
  try {
    if (process.platform !== "darwin" || process.env.TRANTOR_NO_HANDOFF_SPAWN === "1") return false;
    const script = join(HERE, "..", "..", "bin", "open-session.sh");
    if (!existsSync(script)) return false;
    const child = spawn("/bin/bash", [script, projectDir, RECAP_CMD], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch { return false; }
}

// Terminal.app's front window (id + tty) — the fallback when there's no controlling tty (a manual
// handoff runs through the headless Bash tool). The session you're looking at when you invoke it.
export function frontTerminalWindow() {
  if (process.platform !== "darwin") return { id: "", tty: "" };
  try {
    const out = execSync(`osascript -e ${JSON.stringify(`tell application "Terminal" to return (id of front window as string) & "|" & (tty of selected tab of front window)`)}`,
      { encoding: "utf8", timeout: 3000 }).trim();
    const [id, tty] = out.split("|"); return { id: id || "", tty: tty || "" };
  } catch { return { id: "", tty: "" }; }
}

// Resolve the ORIGINAL window (id + tty) to close on takeover. Controlling tty first (if we were
// invoked with one — heartbeat/precompact have it), else the CURRENT front window (a manual baton
// runs through the headless Bash tool with no tty; the session you're looking at is frontmost).
// MUST be called BEFORE spawning the fresh session — once the new window opens it becomes frontmost
// and this would capture IT instead.
export function resolveOriginalWindow() {
  let tty = controllingTty(), windowId = tty ? terminalWindowForTty(tty) : "";
  if (!windowId) { const f = frontTerminalWindow(); windowId = f.id; tty = f.tty; }
  return { windowId, tty };
}

// MANUAL one-command baton: spawn the fresh session (no dialog) + arm the close of THIS window once the
// fresh one consumes the handoff. Returns { spawned, armed, windowId }.
// ORDER IS LOAD-BEARING: resolve the original window BEFORE spawning. Reversing it is the
// "successor closes ITSELF" bug — the just-opened window is frontmost, the front-window fallback
// captures it, and baton-close then kills the FRESH session the moment it takes over. The seams
// (_resolveWindow/_spawnFresh/_armClose) exist so the ordering can be regression-tested headlessly.
export function spawnBaton({ projectDir, handoffFile, conf = readConfig(),
  _resolveWindow = resolveOriginalWindow, _spawnFresh = spawnFresh, _armClose = armBatonClose }) {
  const { windowId, tty } = _resolveWindow();   // original window FIRST, while it's still frontmost
  const spawned = _spawnFresh(projectDir);
  if (!spawned) return { spawned: false, armed: false, windowId: "" };
  const armed = windowId ? _armClose(handoffFile, windowId, tty, conf) : false;
  return { spawned, armed, windowId };
}

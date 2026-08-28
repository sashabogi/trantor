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
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, openSync, readSync, fstatSync, closeSync, rmSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir, hostname } from "node:os";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deriveSubagentManifest } from "../../lib/subagent-manifest.mjs";
import { signedPost } from "./api.mjs";

// Writer and reader MUST resolve the same directory — see lib/project.mjs busDir(). This used to
// honour only RELAY_DATA_DIR while the reader honoured neither override.
export const HANDOFF_DIR = join(process.env.AGENT_BUS_DIR || process.env.RELAY_DATA_DIR || join(homedir(), ".agent-bus"), "handoffs");
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

// ---- in-flight guard --------------------------------------------------------
// True when this session is actively orchestrating sub-agents (Agent/Task tool, Workflow swarms,
// agent-teams): any `agent-*.jsonl` under <transcriptDir>/<sid>/subagents/ (incl. workflows/) was
// written within `withinMs`. The auto baton-pass uses this to DEFER — we must never yank a fresh
// window up (or, before the 2026-06-21 fix, kill the original) while real in-flight agent work is
// running. INCIDENT 2026-06-21: a 90% baton fired mid 2-agent build and the original session was
// SIGKILLed mid-flight. Best-effort; returns false on any error.
// ---- ARMING: the baton waits for a turn boundary --------------------------------------------
// The heartbeat runs on PostToolUse, so the only moment it can ever fire is BETWEEN TWO TOOL CALLS
// — the middle of a turn. On 2026-08-24 that produced a handoff written 36 seconds before the work
// it described was committed, and the successor reported four finished things as still open.
// subagentsActive() was the only mid-flight guard and it only sees spawned sub-agents, not a
// session driving tool calls in its own loop.
//
// So the threshold ARMS and the Stop hook FIRES: at a Stop the turn is complete, which is the only
// point where a summary can describe something finished. One resolver for the marker path, used by
// both hooks, because two hooks disagreeing about a file path is its own recurring bug here.
export function armPath(sessionId) {
  const safe = String(sessionId || "s").replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(process.env.AGENT_BUS_DIR || process.env.RELAY_DATA_DIR || join(homedir(), ".agent-bus"), `handoff-armed-${safe}.json`);
}
export function armBaton(sessionId, payload) {
  try { writeFileSync(armPath(sessionId), JSON.stringify({ ts: Date.now(), ...payload })); return true; } catch { return false; }
}
export function readArm(sessionId) {
  try { const p = armPath(sessionId); if (!existsSync(p)) return null; return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}
export function clearArm(sessionId) {
  try { rmSync(armPath(sessionId), { force: true }); } catch {}
}

export function subagentsActive(transcriptPath, withinMs = 90_000) {
  try {
    if (!transcriptPath) return false;
    const sub = join(dirname(transcriptPath), basename(transcriptPath).replace(/\.jsonl$/i, ""), "subagents");
    if (!existsSync(sub)) return false;
    const cutoff = Date.now() - withinMs;
    const stack = [sub];
    while (stack.length) {
      const d = stack.pop();
      let entries; try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory()) { stack.push(p); continue; }
        if (!/^agent-.*\.jsonl$/i.test(e.name)) continue;
        try { if (statSync(p).mtimeMs >= cutoff) return true; } catch {}
      }
    }
    return false;
  } catch { return false; }
}

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

// Where scrooge actually lives. `command -v` alone was the bug: it installs into ~/.local/bin,
// which is NOT on a default PATH, so every handoff written from a hook, launchd job or precompact
// silently failed the check and dumped raw transcript instead. Those are precisely the automatic
// paths, so the summarizer was missing exactly when nobody was watching. Resolve to an absolute
// path and exec THAT.
const SCROOGE_DIRS = [
  join(homedir(), ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
];
function resolveScrooge() {
  if (process.env.TRANTOR_NO_SCROOGE === "1") return "";   // opt out (tests / no-LLM summary)
  if (process.env.TRANTOR_SCROOGE_BIN && existsSync(process.env.TRANTOR_SCROOGE_BIN)) return process.env.TRANTOR_SCROOGE_BIN;
  try {
    const p = execSync("command -v scrooge", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (p && existsSync(p)) return p;
  } catch {}
  for (const d of SCROOGE_DIRS) { const p = join(d, "scrooge"); if (existsSync(p)) return p; }
  return "";
}

export function buildSummary(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return "*(no transcript available to summarize)*";
  let convo = "";
  try { convo = digest(collectTurns(transcriptPath)); } catch { convo = ""; }
  if (!convo) return "*(transcript unreadable)*";
  const sys = "You are writing a SESSION HANDOFF so a fresh Claude Code session can take over without losing context. The text spans an entire (possibly multi-hour) session: opening turns, an even sample of the middle, and the recent tail. Produce a concise but COMPLETE markdown handoff with these sections: TASK (what we're doing + the goal), STATE (done / in-progress), KEY DECISIONS, OPEN THREADS & NEXT STEPS (concrete actions), KEY FILES & locations (exact paths). Be specific. Cover the whole arc, not just the end. Do not pad.";
  // Cut the raw tail on a TURN boundary. A blind slice(-12000) opens mid-sentence, which is how the
  // 2026-08-24 handoff began, and a successor cannot tell a truncated thought from a complete one.
  const tail = (n) => {
    // Only trim to a turn boundary when we ACTUALLY truncated. When the whole digest fits, trimming
    // would throw away the session's opening — which is the part a successor needs most, and which
    // test-handoff.mjs rightly insists on.
    if (convo.length <= n) return convo;
    const cut = convo.slice(-n);
    const b = cut.indexOf("\n\n");
    return b > 0 && b < 2000 ? cut.slice(b + 2) : cut;
  };
  // Say WHICH failure this was. One string for "not installed" and "the call died" meant nobody
  // could tell a missing tool from a broken one, and the reason only ever reached stderr.
  const degraded = (why) =>
    `*(⚠️ DEGRADED HANDOFF — this is a raw transcript tail, not a written summary.*\n`
    + `*Reason: ${why}. It may open mid-thought and it OMITS anything older than the tail;*\n`
    + `*treat the project's memory files as the reliable record and re-read them before acting.)*\n\n${tail(12000)}`;

  const bin = resolveScrooge();
  if (bin) {
    try {
      // 29s observed summarizing a 56KB digest, so 60s left almost no headroom on a slow provider.
      return execSync(`${JSON.stringify(bin)} -t summarize -d medium --system ${JSON.stringify(sys)}`, {
        input: convo, encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
      }).trim() || degraded("the summarizer returned nothing");
    } catch (e) {
      const why = `the summarizer failed: ${String(e?.message || e).slice(0, 200)}`;
      process.stderr.write(`[trantor] scrooge summarize failed: ${e?.message}\n`);
      return degraded(why);
    }
  }
  return degraded("no summarizer is installed (scrooge was not found on PATH or in the usual locations)");
}

// The exact recent exchange, VERBATIM (not summarized/sampled) — so a baton-pass handoff carries the
// precise in-flight state (e.g. the live cs_live_… URL, the exact decision point) even if the scrooge
// narrative times out on a huge transcript. This is what lets the fresh session truly continue, not guess.
export function verbatimRecentTail(transcript, chars = 7000) {
  try { return collectTurns(transcript).join("\n\n").slice(-chars); } catch { return ""; }
}

// ---- write + announce + spawn ----------------------------------------------
export function writeHandoff({ projectDir, sessionId, transcript, trigger, summary, force = false }) {
  const projectName = basename(projectDir);
  // Server-side storm guard: a session running OLD hooks (before the local markHandedOff guard) re-fires
  // context-warn handoffs every few minutes — the crebral-cortex storm (9 in 49 min, each spawning a
  // window). Ask the hub for clearance (rate-limit per project+session); a non-forced handoff inside the
  // cooldown is SKIPPED — no file, no spawn. Manual (/trantor:handoff) + at-wall (precompact) handoffs
  // force through. Fail-OPEN if the hub is unreachable, so a legit handoff is never blocked.
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
  const narrative = summary ?? buildSummary(transcript);
  const tail = verbatimRecentTail(transcript);
  // Sub-agent manifest SNAPSHOT (fallback). The successor should re-derive it LIVE via
  // `trantor agents <sid>` (catches files an agent finished that were clobbered AFTER this
  // snapshot — the kill that motivated this corrupted a completed 30KB lib post-handoff). This
  // baked copy is just orientation if the live command isn't available. Best-effort; never throws.
  let subagents = null;
  try { subagents = deriveSubagentManifest(transcript, { projectRoot: projectDir }); } catch {}
  // Open verification gates for this project — structured "must verify before shipping" claims that
  // MUST survive the handoff (a narrative line gets skimmed past; this is what the v0.17.31 incident
  // taught — the "verify Gail coefficients" intent vanished into prose). Fetched synchronously from
  // the local hub; best-effort, never blocks the handoff.
  let verifyGates = [];
  try {
    const out = execSync(`curl -s --max-time 2 ${JSON.stringify(relayUrl() + "/verify-gates?project=" + encodeURIComponent(projectName))}`, { encoding: "utf8", timeout: 2500 });
    verifyGates = JSON.parse(out).gates || [];
  } catch {}
  const record = {
    id: `${projectName}-${stamp}`,
    project: projectDir, projectName, machine: hostname(),
    session_id: sessionId || "", trigger: trigger || "auto",
    transcript_path: transcript || "", stamp: Number(stamp) || 0,
    // narrative + a verbatim recent-exchange block so exact in-flight state always survives
    summary: narrative + (tail ? `\n\n---\n## Verbatim recent exchange (exact in-flight state — continue from here)\n${tail}` : ""),
    gitStatus, subagents, verifyGates, consumed: false,
  };
  const file = join(HANDOFF_DIR, `${record.id}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));
  supersedeOlderHandoffs(projectName, record.id);
  return { file, record };
}

// Retire any OTHER still-unconsumed handoff for the same project the moment a newer one lands. The
// fresh session loads the newest-unconsumed; leaving stale siblings around means a scrambled spawn
// (or a future session) could load an out-of-date snapshot. Marking them consumed:true + superseded
// keeps exactly one live handoff per project. Best-effort; never throws into the caller.
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
export function armBatonClose(handoffFile, originalWindowId, originalTty, conf = readConfig(), { auto = false } = {}) {
  try {
    if (process.platform !== "darwin" || !originalWindowId) return false;
    if (process.env.TRANTOR_NO_BATON_CLOSE === "1" || conf.batonClose === false) return false;
    // SAFETY (incident 2026-06-21): an AUTOMATIC baton must NEVER close the original session. At 90%
    // (10% headroom) mid 2-agent build, auto-close SIGKILLed the original window's processes and killed
    // in-flight work — the scariest possible failure. Auto-close is now strictly opt-in
    // (config.autoCloseOriginal:true). The default auto baton just opens the fresh window and LEAVES the
    // original alive. Manual /trantor:handoff still closes (the user explicitly invoked a wrap-up) — and
    // even that is now non-destructive (baton-close never SIGKILLs and aborts if the original is busy).
    if (auto && conf.autoCloseOriginal !== true) return false;
    const closer = join(HERE, "..", "..", "bin", "baton-close.mjs");
    if (!existsSync(closer)) return false;
    const child = spawn(process.execPath, [closer, handoffFile, String(originalWindowId), originalTty || ""], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch { return false; }
}

export async function pingBus(projectName, id, conf = readConfig()) {
  // The detached handoff worker announces on the bus. `from` is the signing identity name so /send's
  // from==signer binding holds; signedPost is fail-open (a down hub never breaks the baton pass).
  const from = `${hostname()}:${projectName}`;
  await signedPost("/send", { from, to: "all",
    text: `📋 Handoff ready for ${projectName} — open a fresh session here to take over (id ${id}).` },
    { session: from, timeoutMs: 2000 });
}

// Spawn a fresh same-agent session (macOS) that takes over via the handoff.
// Default = ON (prompt with a timeout, default button "Open fresh session").
// Disable with config.autoHandoffPrompt:false or env TRANTOR_NO_HANDOFF_SPAWN=1.
export function maybeSpawn(projectDir, conf = readConfig()) {
  try {
    if (process.platform !== "darwin") return false;
    if (process.env.TRANTOR_NO_HANDOFF_SPAWN === "1") return false;
    if (conf.autoHandoffPrompt === false) return false;
    if (hasOrchPane(basename(projectDir))) {
      process.stderr.write(`[trantor] orch pane hosts ${basename(projectDir)} — no Terminal window; the pane claims the handoff on its next open\n`);
      return false;
    }
    const script = join(HERE, "..", "..", "bin", "handoff-prompt.sh");
    if (!existsSync(script)) { process.stderr.write(`[trantor] handoff-prompt.sh missing\n`); return false; }
    const timeout = String(conf.handoffPromptTimeout || 25);
    const child = spawn("/bin/bash", [script, projectDir, timeout], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch (e) { process.stderr.write(`[trantor] maybeSpawn error: ${e?.message}\n`); return false; }
}

// The self-announcing fresh session command (single-quoted so it survives osascript→shell un-escaped).
// The recap must be READABLE: on 2026-08-27 a takeover session answered with three consecutive
// 4-5k-character status dumps and the operator abandoned the app. Brevity is part of the prompt.
export const RECAP_CMD = "claude 'Recap the handoff you just took over — task, state, next step — in at most 3 sentences. Then wait for me. Keep all replies short by default: no status tables, no headers, no walls of text unless I explicitly ask for detail.'";

// Spawn a fresh self-announcing session WITHOUT the dialog (manual handoff — the user already decided).
// ONE suppression check for every path that can open a terminal window. There were two names for
// this — TRANTOR_NO_HANDOFF_SPAWN here and TRANTOR_NO_BATON_SPAWN on spawnBaton — and a drill that
// set the wrong one opened eight live sessions in deleted temp directories, twice. A guard with two
// names is a guard you can miss, so both are honoured wherever a window is opened.
export function spawnSuppressed() {
  return process.env.TRANTOR_NO_HANDOFF_SPAWN === "1" || process.env.TRANTOR_NO_BATON_SPAWN === "1";
}

// Does this project have a hosted orchestrator pane? When it does, the PANE is the successor
// surface: `trantor open` claims the handoff there, and spawning a Terminal window would put the
// fresh session on exactly the surface the operator is trying to leave (#5509 W1). The tracked
// row is the signal — rows are recorded by open and dropped by teardown/prune, and a stale row
// costs only a skipped window, never a lost handoff (the handoff waits, held for the pane).
export function hasOrchPane(projectName) {
  try {
    const state = join(process.env.AGENT_BUS_DIR || process.env.RELAY_DATA_DIR || join(homedir(), ".agent-bus"), "crew-windows.txt");
    if (!existsSync(state)) return false;
    return readFileSync(state, "utf8").split("\n").some(l => {
      const f = l.split("\t");
      return f[0] === projectName && f[1] === "orch";
    });
  } catch { return false; }
}

export function spawnFresh(projectDir) {
  try {
    if (process.platform !== "darwin" || spawnSuppressed()) return false;
    if (hasOrchPane(basename(projectDir))) return false;   // the pane is the successor surface (#5509)
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
  // A DRILL MUST BE ABLE TO SAY NO. There was no such switch, so exercising the baton path in a
  // test opened real Terminal windows running real `claude` sessions in temp directories the test
  // then deleted, each parked on a "do you trust this folder?" prompt. Five of them were found by
  // the operator on 2026-08-24. A code path that spawns windows needs an off switch, or it cannot
  // be tested honestly and someone will fake one that does not exist.
  if (spawnSuppressed() || conf.batonSpawn === false) {
    return { spawned: false, armed: false, windowId: "", suppressed: true };
  }
  const { windowId, tty } = _resolveWindow();   // original window FIRST, while it's still frontmost
  const spawned = _spawnFresh(projectDir);
  if (!spawned) return { spawned: false, armed: false, windowId: "" };
  const armed = windowId ? _armClose(handoffFile, windowId, tty, conf) : false;
  return { spawned, armed, windowId };
}

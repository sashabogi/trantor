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
import { join, basename, dirname, sep } from "node:path";
import { homedir, hostname } from "node:os";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deriveSubagentManifest } from "../../lib/subagent-manifest.mjs";
import { signedPost, loadIdentity } from "./api.mjs";
// #7037: signedHeaders is SYNCHRONOUS, which is why this path can sign at all — see hubCallSync.
import { signedHeaders } from "../../lib/signed-fetch.mjs";
import { loadAutonomy, resolveAutonomy } from "../../lib/autonomy.mjs";
import { resolveProject, orchSessionsPath, hostId } from "../../lib/project.mjs";
// Trantor State (TDD §4.5). Dark behind TRANTOR_STATE_HANDOFF: these are imported unconditionally
// because they are pure modules with no side effects at load, and a lazy import would make
// attachState async on a path that is deliberately synchronous.
import { statePath, readState } from "../../lib/state/store.mjs";
import { stateError } from "../../lib/state/schema.mjs";
import { deriveState } from "../../lib/state/derive.mjs";

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
  const rows = [];
  let model = "";
  for (const line of lines) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    const u = r?.message?.usage;
    if (r?.type !== "assistant" || !u) continue;
    const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (tokens <= 0) continue;
    rows.push(tokens);
    model = r.message.model || model;
  }
  const tokens = guardContextTokens(rows);
  if (tokens == null) return null;
  const window = resolveWindow(model, conf);
  return { tokens, window, frac: window ? tokens / window : null, model };
}

// The #5572 poison guard — the SAME rule, from the SAME fixture manifest
// (test/fixtures/context/manifest.json), as the desktop gauge's ContextGuard: the baton must
// read what the gauge reads, or the banner and the heartbeat disagree. Report the last row
// unless it falls below 40% of the session max; then report the recent maximum (a lone
// collapsed row is an artifact — across 1,839 usage rows in the two incident-era transcripts,
// zero real drops below that floor were observed) unless the last FIVE rows all sit below the
// floor: a sustained new level is reality, accept it.
export function guardContextTokens(rows) {
  let max = 0;
  const recent = [];
  for (const t of rows) {
    if (!t || t <= 0) continue;
    recent.push(t);
    if (recent.length > 5) recent.shift();
    if (t > max) max = t;
  }
  if (!recent.length) return null;
  const last = recent[recent.length - 1];
  const floor = max * 0.4;
  if (last >= floor) return last;
  if (recent.length === 5 && recent.every(r => r < floor)) return last;
  return Math.max(...recent);
}

// The transcript logs the model WITHOUT the [1m] marker, so we cannot tell a
// 200k window from a 1M one in general. Fable is the known exception (#5503):
// its window is 1M and the name is all the transcript ever gives us — the
// undeclared window kept the early-warning off and the session hit the wall
// silently. An explicit declaration (env RELAY_CONTEXT_WINDOW or
// config.contextWindow) always wins over any name-based inference. Returns 0
// when unknown (→ no warning).
export function resolveWindow(model = "", conf = readConfig()) {
  const explicit = Number(process.env.RELAY_CONTEXT_WINDOW || conf.contextWindow || 0);
  if (explicit > 0) return explicit;
  if (/\[1m\]|-1m\b|:1m\b/i.test(model)) return 1_000_000; // honored if ever present
  if (/fable/i.test(model)) return 1_000_000;              // #5503: fable is 1M by name
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
// The hard cap on an arm (#6528): a session that never reaches a Stop must still hand off —
// the heartbeat fires at the next tool boundary once the arm is this old. One source for the
// number, because the CLI (bin/baton.mjs) prints it in its armed message and the heartbeat
// enforces it; two copies would drift and the printed promise would be a lie.
export function armMaxMs() {
  const n = Number(process.env.TRANTOR_BATON_ARM_MAX_MS);
  return Number.isFinite(n) && n > 0 ? n : 15 * 60 * 1000;
}
export function armBaton(sessionId, payload) {
  try {
    // Re-arming must NOT refresh the timestamp (#6528): the banner can re-fire the request
    // every few seconds, and a slid-forward ts would starve the hard cap forever — an arm
    // that is always brand-new never ages into the heartbeat's fire-anyway backstop. The
    // FIRST arm's ts is the arm's age; later writes only refresh the payload.
    const prior = readArm(sessionId);
    const ts = prior?.ts || Date.now();
    writeFileSync(armPath(sessionId), JSON.stringify({ ts, ...payload }));
    return true;
  } catch { return false; }
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

// ---- #6528: THE ONE GATE — is this session's turn still in flight? --------------------------
// Two signals, both read from artifacts the session itself already writes:
//   1. subagentsActive() — a spawned sub-agent wrote its transcript recently. The 90s mtime
//      window is a false-idle risk (a sub-agent in a long model stretch writes nothing for
//      minutes — that is exactly how orca-onboarding-map went unseen on #6528), but widening
//      it only ever DEFERS a handoff, never fires one early — the safe direction.
//   2. the transcript TAIL — the last real row tells where the turn stands. A user row
//      carrying tool_result means the model is about to continue (mid-turn). An assistant
//      row carrying tool_use means a result is still owed (mid-turn). Only an assistant row
//      that is plain text (the turn's closing words) reads as idle — the same state the Stop
//      hook fires on.
// Every path that can WRITE+SPAWN a handoff (heartbeat backstop, Stop hook, `trantor handoff`)
// asks this before firing; only an operator's own typed command or the explicit hard-cap leg
// (--force) may bypass it.
const TAIL_BYTES = 262_144;
function transcriptTailRows(transcriptPath) {
  const fd = openSync(transcriptPath, "r");
  try {
    const size = fstatSync(fd).size;
    const want = Math.min(size, TAIL_BYTES);
    const b = Buffer.alloc(want);
    readSync(fd, b, 0, want, size - want);
    // Drop the first (possibly partial) line, then parse what follows.
    return b.toString("utf8").split("\n").slice(1).filter(Boolean);
  } finally { closeSync(fd); }
}
export function lastRowMidTurn(transcriptPath) {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return false;
    const rows = transcriptTailRows(transcriptPath);
    for (let i = rows.length - 1; i >= 0; i--) {
      let r; try { r = JSON.parse(rows[i]); } catch { continue; }
      if (r?.type !== "assistant" && r?.type !== "user") continue;   // metadata rows say nothing
      const c = r?.message?.content;
      if (r.type === "assistant") {
        const blocks = Array.isArray(c) ? c : [];
        const calls = blocks.filter(b => b?.type === "tool_use");
        // #6668: a session parked in a LONE relay_wait is at its boundary. The wait is not work
        // in flight — everything the turn did is already on disk, and the tool returns only when
        // the bus speaks. Reading it as mid-turn armed the baton for the 17-minute boundary wait
        // on a turn that never ends on its own; the pre-kill idle gate's deadline is what ends it.
        if (calls.length && calls.every(isRelayWaitCall)) return false;
        if (calls.length) return true;                               // a result is still owed
        return false;                                                // text-only → turn said its piece
      }
      // user row: #6528 follow-up — a trailing user row of ANY kind means in flight. A
      // tool_result is the model mid-cycle, and a PLAIN prompt is the model WORKING on that
      // prompt: Claude Code does not flush the assistant turn until it ends, so the assistant
      // row's absence is not idle evidence. The only idle evidence is the text-only assistant
      // row above, or the Stop hook itself.
      return true;
    }
    return false;
  } catch { return false; }
}
export function turnInFlight(transcriptPath) {
  return subagentsActive(transcriptPath) || lastRowMidTurn(transcriptPath);
}
// The relay MCP's wait tool, by any server prefix (mcp__plugin_trantor_relay__relay_wait,
// mcp__trantor__relay_wait, a bare relay_wait in a fixture).
function isRelayWaitCall(block) {
  return /(^|__)relay_wait$/.test(String(block?.name || ""));
}

// ---- does the transcript's session still have a process? (#6668) ------------------------------
// Claude Code registers every live session in ~/.claude/sessions/<pid>.json ({pid, sessionId,
// cwd, ...}) and removes the file at exit. The 09-07 12:35 chain armed on a transcript whose
// session had exited at 12:16: the transcript's last row was a tool_result ("Connection closed"),
// so the boundary gate read it as mid-turn and waited on a turn that no process would ever end.
// A session with no live process IS at its boundary — its record can be written now.
//   "live"    an entry names this session and its pid answers kill -0
//   "dead"    the registry is in use (some other session is live) and none of its live entries
//             name this session
//   "unknown" no registry, or nothing in it is alive — say nothing, the boundary gate decides
// The "dead" verdict needs another LIVE entry on purpose: a Claude Code too old to keep the
// registry must not turn every mid-turn handoff into an immediate write.
export function sessionProcessState(sessionId, { home = homedir() } = {}) {
  if (!sessionId) return "unknown";
  let files;
  try { files = readdirSync(join(home, ".claude", "sessions")).filter(f => f.endsWith(".json")); } catch { return "unknown"; }
  let anyLive = false;
  for (const f of files) {
    let entry;
    try { entry = JSON.parse(readFileSync(join(home, ".claude", "sessions", f), "utf8")); } catch { continue; }
    const pid = Number(entry?.pid) || Number(basename(f, ".json")) || 0;
    if (!(pid > 0) || !pidAlive(pid)) continue;
    anyLive = true;
    if (String(entry?.sessionId || "") === sessionId) return "live";
  }
  return anyLive ? "dead" : "unknown";
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
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
    // SAFETY: this IS the transcript I/O boundary — the jsonl row was JSON.parse'd above and
    // Claude message content is documented as a string or an array of typed blocks; the two
    // branches decode exactly those shapes, anything else stays "".
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
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
  const sys = "You are writing a SESSION HANDOFF so a fresh Claude Code session can take over without losing context. The text spans an entire (possibly multi-hour) session: opening turns, an even sample of the middle, and the recent tail. Produce a concise but COMPLETE markdown handoff with these sections: TASK (what we're doing + the goal), STATE (done / in-progress), KEY DECISIONS, OPEN THREADS & NEXT STEPS (concrete actions), KEY FILES & locations (exact paths). Be specific. Cover the whole arc, not just the end. The finished handoff must fit ~3500 characters — anything longer is capped with an elision marker and the elided middle (usually STATE) is exactly what the successor needed (#6528), so compress the arc, never drop a section. Do not pad.";
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

// ---- #5648: handoff writer discipline --------------------------------------
// The inline summary is the RECAP, not the record: the successor reads it as a hook injection,
// and an oversized injection gets persisted to a file the successor re-reads — paying twice for
// the same context. Cap the composed digest at ~4KB. When it must cut, keep BOTH ends a successor
// needs — the opening (task & goal framing) and the tail (current state) — cutting each on a
// paragraph boundary, with an explicit elision marker so nobody mistakes the middle for missing.
export function capSummary(text, cap = 4096) {
  const s = String(text || "");
  if (s.length <= cap) return s;
  const elide = "\n\n[…]\n\n";
  const headRaw = s.slice(0, Math.max(0, cap - elide.length - 2048));
  const hCut = headRaw.lastIndexOf("\n\n");
  const head = hCut > 200 ? headRaw.slice(0, hCut) : headRaw;
  let tail = s.slice(s.length - (cap - head.length - elide.length));
  const tCut = tail.indexOf("\n\n");
  if (tCut > 0 && tCut < 2000) tail = tail.slice(tCut + 2);   // drop the partial opening line
  return head + elide + tail;
}

// ---------------------------------------------------------------------------------------------
// Trantor State — the structured field on the record (TDD §4.5). `summary` keeps being written
// exactly as it is today; `state` rides beside it, validated on write and NEVER capped. That is
// the whole fix for #6528: capSummary's mid-string elision ate the STATE section of the prose, and
// the structured field cannot lose a member because the lossy operation is not applied to it.
// ---------------------------------------------------------------------------------------------

/** Dark by default. The prose path is untouched either way; this flag only decides whether the
 *  structured field is built and rendered (TDD §4.5, "Fallback"). */
export function stateHandoffEnabled(env = process.env) {
  return ["1", "true", "on", "yes"].includes(String(env.TRANTOR_STATE_HANDOFF || "").toLowerCase());
}

/** The bus id of the seat writing this handoff — the same resolution sessionstart.mjs uses, so a
 *  sidecar written under the runner's seat name is the one this path reads back. */
export function resolveSeat(projectName, env = process.env) {
  return env.RELAY_SESSION || (env.RELAY_AGENT ? `${env.RELAY_AGENT}:${projectName}` : `${hostId()}:${projectName}`);
}

// ── #7037: one SIGNED, synchronous hub call, and an error that cannot be mistaken for data ──────
//
// Three reads on this path curl'd the hub UNSIGNED and read the refusal as an answer. The hub
// replies 401 {"error":"signature required"}; a 401 body is VALID JSON, so `JSON.parse(out).tasks
// || []` parses fine, finds no `tasks` key, and hands back an empty list. The catch never fires
// because nothing threw. Silently, on every handoff: the card id resolved to 0, the verify-gate
// list to [], and the storm guard — which exists because an old-hook session once fired 9 handoffs
// in 49 minutes — read a refusal as "allowed" and stopped guarding.
//
// So the shape matters more than the signature: this returns { ok, status, json, reason } and NEVER
// a bare list. A caller has to look at `ok` before it can reach the data, which is the property the
// old code lacked. An auth failure must not be spellable as an empty result.
//
// Synchronous on purpose — this whole path is (see the state imports above), so api.mjs's async
// signedGet is unavailable. signedHeaders IS synchronous, so only the transport differs.
function hubCallSync(path, { project, session, method = "GET", body, timeoutMs = 2500 } = {}) {
  const url = relayUrl(project) + path;
  let headers = {};
  try {
    headers = signedHeaders(loadIdentity(session || resolveSeat(project || "")), url, { method, body });
  } catch { /* unsigned is still worth attempting — the hub decides, not us */ }
  const args = Object.entries(headers).map(([k, v]) => `-H ${JSON.stringify(`${k}: ${v}`)}`);
  if (method !== "GET") args.push("-X", method);
  if (body !== undefined) args.push("-H 'content-type: application/json'", "-d", JSON.stringify(body));
  try {
    // maxBuffer is NOT decoration: /tasks on this project is 1.6MB across 941 cards, and execSync's
    // 1MB default turns that into ENOBUFS — which the old catch would have swallowed straight back
    // into the same silent 0. A fix that only signed the request would still have failed here.
    const out = execSync(
      `curl -s --max-time ${Math.ceil(timeoutMs / 1000)} ${args.join(" ")} -w '\\n%{http_code}' ${JSON.stringify(url)}`,
      { encoding: "utf8", timeout: timeoutMs + 500, maxBuffer: 32 * 1024 * 1024 });
    const cut = out.lastIndexOf("\n");
    const status = Number(out.slice(cut + 1).trim()) || 0;
    const text = cut >= 0 ? out.slice(0, cut) : out;
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    if (status < 200 || status >= 300) {
      return { ok: false, status, json, reason: json?.error ? `HTTP ${status}: ${json.error}` : `HTTP ${status}` };
    }
    return { ok: true, status, json, reason: "" };
  } catch (e) {
    return { ok: false, status: 0, json: null, reason: e?.message || "unreachable" };
  }
}

// A refusal is worth exactly one line on stderr, and it must name the endpoint and the reason — the
// whole cost of this bug was that it made no sound at all. Never throws into the handoff path: a
// session losing its baton over a warning is a worse failure than the one being reported.
function warnHubRead(what, r) {
  try { process.stderr.write(`[trantor] handoff: ${what} unavailable — ${r.reason || "unknown"}; continuing without it\n`); } catch {}
}

/**
 * Which card this handoff belongs to. `TRANTOR_CARD` wins — the crew runner knows the answer for
 * certain and a lookup cannot beat being told. Otherwise ask the hub for this seat's newest open
 * card, on the same 2s best-effort budget as the verify-gates fetch: a hub that is down costs the
 * handoff a card number, never the handoff.
 *
 * #7037: reads /catchup, not /tasks. /tasks is the whole board with every card's full log — 1.6MB
 * here, 625-961ms typical, and it already blew a 1500ms budget once today (#6983). /catchup answers
 * the question actually being asked in a few hundred bytes. Its buckets are capped at 8, so "my
 * card is not in the list" and "the list was truncated before it got to me" are different answers,
 * and the second is reported as UNKNOWN rather than quietly resolving to 0 — which is the same
 * defect this card exists to remove, one layer up.
 */
export function resolveHandoffCard({ projectName, seat, env = process.env } = {}) {
  const told = Number(env.TRANTOR_CARD);
  if (Number.isInteger(told) && told > 0) return told;
  const r = hubCallSync(`/catchup?project=${encodeURIComponent(projectName)}`, { project: projectName, session: seat });
  if (!r.ok) { warnHubRead(`card lookup for ${projectName}`, r); return 0; }
  const CAP = 8;                       // hub-side pick() limit; keep in step with /catchup
  for (const status of ["doing", "testing"]) {
    const bucket = Array.isArray(r.json?.[status]) ? r.json[status] : [];
    const mine = bucket
      .filter(t => t && Number.isInteger(t.id) && t.assignee === seat)
      .sort((a, b) => (b.updated || 0) - (a.updated || 0));
    if (mine.length) return mine[0].id;
    if (bucket.length >= CAP) {
      warnHubRead(`card lookup for ${projectName}`,
        { reason: `/catchup ${status} list truncated at ${CAP} — this seat's card may exist but was not returned` });
      return 0;
    }
  }
  return 0;
}

/**
 * Attach the structured working state to a handoff record, from two sources in order:
 *   1. the sidecar, when one exists (Phase 2a and after) — read, migrated, validated;
 *   2. derived from git + the model's own STATE block, when none does (every Phase-1 handoff).
 *
 * Invalid or underivable state attaches `null` and logs. It NEVER blocks a handoff: a session at
 * the context wall losing its baton because a state object would not validate is a far worse
 * failure than a successor reading prose, which is exactly what it read before this field existed.
 * @returns {object|null} the attached state
 */
export function attachState(rec, { project, seat, card, worktree, env = process.env } = {}) {
  if (!stateHandoffEnabled(env)) return null;
  try {
    const name = project || rec?.projectName || "";
    const who = seat || resolveSeat(name, env);
    const no = Number.isInteger(card) ? card : 0;
    const cwd = worktree || rec?.project || "";

    let state = null;
    const sidecar = statePath(who, no, name);
    if (sidecar && existsSync(sidecar)) {
      const r = readState(who, no, { project: name, cwd, recover: false });
      if (!r.ok) throw new Error(`sidecar rejected: ${r.code} at ${r.at} — ${r.message}`);
      state = r.state;
    } else {
      state = deriveState({ project: name, seat: who, card: no, worktree: cwd, handoffText: rec?.summary || "" });
    }

    const why = state ? stateError(state) : "no state could be derived";
    if (why) throw new Error(why);
    rec.state = state;
    return state;
  } catch (e) {
    process.stderr.write(`[trantor] handoff state skipped: ${e?.message || e}\n`);
    rec.state = null;
    return null;
  }
}

/** The state as the successor reads it: one compact block, bounded by the schema's own caps, with
 *  the absence of credit stated rather than implied. */
export function renderStateBlock(state) {
  const line = (items) => items.map(i => `${i.id} ${i.text}${i.paths?.length ? ` [${i.paths.join(", ")}]` : ""}`).join("; ");
  const rows = [];
  if (state?.task) rows.push(`task: ${state.task}`);
  for (const [list, label] of [["done", "done"], ["in_flight", "in flight"], ["next", "next"], ["blockers", "blockers"]]) {
    const items = state?.[list] || [];
    if (!items.length) continue;
    const more = list === "done" && state.done_count ? ` (+${state.done_count} compacted)` : "";
    rows.push(`${label} (${items.length}${more}): ${line(items)}`);
  }
  const files = state?.files || {};
  const paths = Object.keys(files);
  const verified = paths.filter(p => files[p].verified === true);
  if (paths.length) rows.push(`files: ${paths.length} touched, ${verified.length} verified${verified.length ? ` — ${verified.join(", ")}` : ""}`);
  const verify = Object.entries(state?.verify || {});
  if (verify.length) rows.push(`verify: ${verify.map(([k, v]) => `${k}=${v}`).join(" ")}`);
  if (!rows.length) return "";   // nothing to render is not a block with a warning in it
  if (!verified.length) {
    rows.push("NO PATH IS VERIFIED HERE — no gate ran at the handoff. Nothing in this block is evidence: re-earn it before you move anything to done.");
  }
  if (state.notes) rows.push(`notes: ${state.notes}`);
  return rows.join("\n");
}

// How fresh a model-authored handoff must be before an automatic digest DEFERS to it: 15 minutes.
// Older than that, the state it describes has likely moved on — compose fresh.
const FRESH_HANDOFF_SEC = 15 * 60;
const MANUAL_TRIGGERS = ["manual-skill", "manual-baton"];

// The newest unconsumed MODEL-authored handoff (the /trantor:handoff skill / manual baton path)
// for this project, if it is still fresh. Incident (#5648): minutes after the operator hand-wrote
// trantor-1788141357, an automatic digest recomposed and SUPERSEDED it — the successor then
// loaded the machine's lossy summary instead of the author's exact words. The digest is the
// fallback, never the replacement.
export function freshAuthoredHandoff(projectName, nowS = nowSec() || Math.floor(Date.now() / 1000)) {
  try {
    if (!existsSync(HANDOFF_DIR)) return null;
    const re = new RegExp("^" + String(projectName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-(\\d+)\\.json$");
    const cands = readdirSync(HANDOFF_DIR)
      .map(f => { const m = re.exec(f); return m ? { f, stamp: Number(m[1]) } : null; })
      .filter(Boolean)
      .sort((a, b) => b.stamp - a.stamp)
      .map(x => join(HANDOFF_DIR, x.f));
    for (const p of cands) {
      try {
        const r = JSON.parse(readFileSync(p, "utf8"));
        if (r.consumed !== false) continue;
        if (!MANUAL_TRIGGERS.includes(r.trigger)) continue;
        if (nowS - (Number(r.stamp) || 0) > FRESH_HANDOFF_SEC) continue;
        return r;
      } catch {}
    }
  } catch {}
  return null;
}

// mode:"attended"|"unattended" on every handoff record (#5648) — WHO pulls the baton trigger.
// Read from the resolved autonomy dials (the same JSON `trantor autonomy json` prints):
// baton:"auto" means the arm-at-warn → fire-at-turn-boundary chain runs itself (unattended);
// the default "ask" keeps the operator in the loop (attended). Fail closed to "attended".
export function handoffMode(projectName) {
  try {
    const a = resolveAutonomy(projectName, loadAutonomy());
    return a.baton === "auto" ? "unattended" : "attended";
  } catch { return "attended"; }
}

// ---- write + announce + spawn ----------------------------------------------
/** Append one §5 state transition to a handoff's own file — the machine's ledger rides the
 *  record it describes (SYSTEM-CONTRACT §5): every owner of a transition already holds this
 *  file, it survives both sessions it connects, and no network is involved. Best-effort. */
export function appendHandoffState(id, state, by = "") {
  try {
    const p = join(HANDOFF_DIR, `${id}.json`);
    const rec = JSON.parse(readFileSync(p, "utf8"));
    if (!Array.isArray(rec.states)) rec.states = [];
    rec.states.push({ state, ts: nowSec() || Math.floor(Date.now() / 1000), by });
    writeFileSync(p, JSON.stringify(rec, null, 2));
    return true;
  } catch { return false; }
}

export function writeHandoff({ projectDir, sessionId, transcript, trigger, summary, force = false, projectName: projectNameArg }) {
  // #6074: the NAME may come from the session's registration (resolveHandoffSurface), not from
  // this directory's basename — a subfolder cwd must not rename the project on the record.
  const projectName = projectNameArg || basename(projectDir);
  // Server-side storm guard: a session running OLD hooks (before the local markHandedOff guard) re-fires
  // context-warn handoffs every few minutes — the crebral-cortex storm (9 in 49 min, each spawning a
  // window). Ask the hub for clearance (rate-limit per project+session); a non-forced handoff inside the
  // cooldown is SKIPPED — no file, no spawn. Manual (/trantor:handoff) + at-wall (precompact) handoffs
  // force through. Fail-OPEN if the hub is unreachable, so a legit handoff is never blocked.
  if (!force) {
    // #7037: this is the costliest of the three unsigned reads. A 401 body parses, `r.allow` comes
    // back undefined, `undefined === false` is false — so the guard said "go" on every handoff and
    // the storm it exists to stop had nothing standing in its way. Signed now, and a REFUSAL is
    // distinguished from a DENIAL: only a hub that answered gets to allow or deny.
    const r = hubCallSync("/handoff", {
      project: projectName, session: sessionId || "", method: "POST",
      body: { project: projectName, session: sessionId || "", trigger: trigger || "auto" },
    });
    if (!r.ok) warnHubRead("storm guard", r);   // fail-OPEN, but never silently
    else if (r.json && r.json.allow === false) return { skipped: true, reason: r.json.reason || "storm-guard", sinceSec: r.json.sinceSec };
  }
  if (!existsSync(HANDOFF_DIR)) mkdirSync(HANDOFF_DIR, { recursive: true });
  // #5648: an automatic digest must never recompose+supersede a FRESH model-authored handoff.
  // If one exists (<15min, unconsumed), point the baton at THAT and write nothing — the caller's
  // spawn path proceeds on the authored handoff exactly as if it had just written it.
  const fresh = freshAuthoredHandoff(projectName);
  if (fresh) return { deferred: true, file: join(HANDOFF_DIR, `${fresh.id}.json`), record: fresh };
  const stamp = nowSec() || Date.now();
  let gitStatus = "";
  try { gitStatus = execSync("git -C " + JSON.stringify(projectDir) + " status --short 2>/dev/null | head -30", { encoding: "utf8" }).trim(); } catch {}
  // Cap the composed narrative to the injection budget (~4KB). The verbatim tail is deliberately
  // NOT embedded anymore: the record's transcript_path points at the full exchange, and embedding
  // it here doubled the successor's read for state that was already one path away (#5648).
  const narrative = capSummary(summary ?? buildSummary(transcript));
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
  // #7037: signed, and an unreadable list is reported rather than rendered as "no open gates" —
  // a record that silently claims zero gates is worse than one that admits it could not ask.
  let verifyGates = [];
  {
    const r = hubCallSync(`/verify-gates?project=${encodeURIComponent(projectName)}`, { project: projectName, session: sessionId || "" });
    if (r.ok) verifyGates = Array.isArray(r.json?.gates) ? r.json.gates : [];
    else warnHubRead(`verify gates for ${projectName}`, r);
  }
  const record = {
    id: `${projectName}-${stamp}`,
    project: projectDir, projectName, machine: hostname(),
    session_id: sessionId || "", trigger: trigger || "auto",
    transcript_path: transcript || "", stamp: Number(stamp) || 0,
    // recap-sufficient inline summary, capped ~4KB — the full story lives at transcript_path
    summary: narrative,
    // attended|unattended — who pulls the baton trigger (resolved autonomy `baton` dial)
    mode: handoffMode(projectName),
    gitStatus, subagents, verifyGates, consumed: false,
    // The §5 machine's ledger: every transition appends here via appendHandoffState.
    states: [{ state: "written", ts: Number(stamp) || 0, by: sessionId || "" }],
  };
  // The structured field (TDD §4.5), dark behind TRANTOR_STATE_HANDOFF. It is attached AFTER the
  // record is built because it reads `summary` — the model's own STATE block is one of its two
  // sources — and BEFORE the write, so the field lands in the same file the successor loads.
  const seat = resolveSeat(projectName);
  attachState(record, { project: projectName, seat, card: resolveHandoffCard({ projectName, seat }), worktree: projectDir });
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
    // #6074: a session in a hosted pane never gets a Terminal window — the pane is the successor
    // surface, and the pane claims the handoff (trantor open) on its own.
    if (paneSurfaceEnv()) {
      process.stderr.write(`[trantor] session lives in herdr pane ${paneSurfaceEnv()} — no Terminal window; the pane claims the handoff\n`);
      return false;
    }
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

// ---- #6074: WHERE the session lives, and WHICH project it is ----------------
// Witnessed 2026-09-02 (crebral-scribe/ios): a pane session ran the handoff skill with its shell
// cwd in a subfolder. The project name came from basename(cwd) = "ios", the pane lookup found no
// "ios" row, and the baton fell to the window leg — whose front-Terminal-window fallback picked a
// window the pane session never owned, spawned a stray Terminal session, and armed a close on a
// stranger's window. Two facts the code ignored: a session's OWN env knows where it lives
// (HERDR_PANE_ID — herdr sets it in every pane), and the project's REGISTRATION knows its name
// (the `trantor open` badge, RELAY_PROJECT, the orch-sessions map) long before cwd is worth
// consulting. One resolver, shared by write-handoff.mjs --baton AND bin/baton.mjs, so the skill
// path and the CLI path cannot diverge.
export function paneSurfaceEnv(env = process.env) {
  return String(env.HERDR_PANE_ID || "").trim();
}

// Reverse orch-sessions.txt lookup: which project recorded THIS session id as its orchestrator
// thread. One row per project, "<project>\t<sid>" — written by `trantor open` / adopt / claim.
export function orchProjectForSession(sid) {
  try {
    if (!sid) return "";
    for (const line of readFileSync(orchSessionsPath(), "utf8").split("\n")) {
      const [p, s] = line.split("\t");
      if (p && s && s.trim() === String(sid).trim()) return p.trim();
    }
  } catch {}
  return "";
}

// Does the cwd actually lie inside THIS project's ground (#6218)? Two true homes: a directory
// named for the project (the project root or anything below it — the #6074 subfolder case), and
// the project's agent-bus worktrees (<bus>/worktrees/<project>/<seat>). Pure + exported so the
// drill can pin both without touching the operator's disk layout.
export function cwdInsideProject(projectName, dir, bus = process.env.AGENT_BUS_DIR || process.env.RELAY_DATA_DIR || join(homedir(), ".agent-bus")) {
  if (!projectName || !dir) return false;
  const wt = join(bus, "worktrees", projectName);
  if (dir === wt || dir.startsWith(wt + sep)) return true;
  let cur = dir;
  for (;;) {
    if (basename(cur) === projectName) return true;
    const parent = dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

// The one resolver. Returns { project, projectDir, pane, surface }:
//   pane    — the session's own pane id ("" when it is not a hosted pane)
//   surface — "pane" (the baton MUST take the pane leg) or "window" (today's behavior)
//   project — the REGISTERED project name; a subfolder cwd never renames it
// #6218 — the badge wins only where it is TRUE. Witnessed 2026-09-03: a run from a
// trantor-badged shell in ~/development/tiny-timer wrote "handoff saved for trantor" with
// tiny-timer's transcript inside. #6074's registration-before-cwd rule was written for a
// subfolder cwd of the SAME project; a FOREIGN project dir is a different case and must not be
// silently relabeled. So the badge (and the rest of the registration chain behind it) claims
// this handoff only when the cwd lies inside the named project's directory or one of its
// worktrees; a badged shell sitting elsewhere resolves from the cwd, and ONE warning line names
// both — the badge that lied and the project the record actually went to.
export function resolveHandoffSurface({ projectDir, sessionId, env = process.env } = {}) {
  const dir = projectDir || env.CLAUDE_PROJECT_DIR || process.cwd();
  const badge = String(env.TRANTOR_ORCH || "").trim();
  let project = "";
  let foreignBadge = "";
  if (badge && badge !== "1") {                                      // `trantor open` badge carries the name
    if (cwdInsideProject(badge, dir)) project = badge;
    else foreignBadge = badge;                                       // the badge lies about this cwd
  }
  if (!project && !foreignBadge && env.RELAY_PROJECT) project = String(env.RELAY_PROJECT).trim();
  if (!project && !foreignBadge) project = orchProjectForSession(sessionId);
  // Last resort: the cwd (git-root aware). With a foreign badge, the shell's own RELAY_PROJECT
  // is scrubbed from the fallback's env — it is the same registration that just lied (#6218).
  if (!project) project = resolveProject(dir, foreignBadge ? { ...env, RELAY_PROJECT: "" } : env);
  if (foreignBadge) {
    console.error(`trantor handoff: TRANTOR_ORCH=${foreignBadge} but the working directory (${dir}) is not inside ${foreignBadge}'s project or its worktrees — saving the handoff for ${project} (resolved from the cwd)`);
  }
  return { project, projectDir: dir, pane: paneSurfaceEnv(env), surface: paneSurfaceEnv(env) ? "pane" : "window" };
}

export function spawnFresh(projectDir) {
  try {
    if (process.platform !== "darwin" || spawnSuppressed()) return false;
    if (paneSurfaceEnv()) return false;                    // #6074: pane sessions never open windows
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

// The pane leg of the baton (#5643): hand the replacement to a DETACHED driver (bin/baton-pane.mjs)
// that survives this session's death — idle-gate → graceful end → trantor open → kickoff. The
// window machinery (resolve/arm-close) is deliberately absent here: there is no window to close,
// and the old path's answer ("spawn disabled — open manually") left the operator doing the
// machine's job by hand.
export function spawnPaneBaton(projectDir, handoffFile, paneId = "") {
  try {
    const script = join(HERE, "..", "..", "bin", "baton-pane.mjs");
    if (!existsSync(script)) return false;
    // #6074: when the dying session KNOWS its pane (HERDR_PANE_ID), pass it — the driver must
    // replace THAT pane, not guess one from a crew-windows row keyed by a cwd-derived name.
    const args = [script, "--project", projectDir, "--handoff", handoffFile];
    if (paneId) args.push("--pane", paneId);
    const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch { return false; }
}

// MANUAL one-command baton: spawn the fresh session (no dialog) + arm the close of THIS window once the
// fresh one consumes the handoff. Returns { spawned, armed, windowId }.
// ORDER IS LOAD-BEARING: resolve the original window BEFORE spawning. Reversing it is the
// "successor closes ITSELF" bug — the just-opened window is frontmost, the front-window fallback
// captures it, and baton-close then kills the FRESH session the moment it takes over. The seams
// (_resolveWindow/_spawnFresh/_armClose/_hasPane/_spawnPane) exist so the ordering can be
// regression-tested headlessly.
export function spawnBaton({ projectDir, handoffFile, conf = readConfig(),
  _resolveWindow = resolveOriginalWindow, _spawnFresh = spawnFresh, _armClose = armBatonClose,
  _hasPane = hasOrchPane, _spawnPane = spawnPaneBaton, _env = process.env }) {
  // A DRILL MUST BE ABLE TO SAY NO. There was no such switch, so exercising the baton path in a
  // test opened real Terminal windows running real `claude` sessions in temp directories the test
  // then deleted, each parked on a "do you trust this folder?" prompt. Five of them were found by
  // the operator on 2026-08-24. A code path that spawns windows needs an off switch, or it cannot
  // be tested honestly and someone will fake one that does not exist. The check reads the REAL env
  // (spawnSuppressed) AND the injected one (_env) — a crew runner exports TRANTOR_NO_*_SPAWN for
  // its seats, and a drill that inherits that must still be able to exercise each branch by
  // passing its own env, not by mutating the runner's.
  const suppressed = spawnSuppressed()
    || String(_env.TRANTOR_NO_HANDOFF_SPAWN || "") === "1" || String(_env.TRANTOR_NO_BATON_SPAWN || "") === "1";
  if (suppressed || conf.batonSpawn === false) {
    return { spawned: false, armed: false, windowId: "", suppressed: true };
  }
  // #6074, checked FIRST: the session's OWN env is the truth about where it lives. HERDR_PANE_ID
  // set means the pane leg, keyed by THAT pane id — regardless of cwd or project name — and the
  // whole window machinery (resolve + spawn + arm-close) is forbidden here: a pane session has no
  // Terminal window, so the front-window fallback can only ever pick a stranger's (the witnessed
  // crebral-scribe/ios incident armed a close on a window this session never owned).
  const paneId = paneSurfaceEnv(_env);
  if (paneId) {
    const spawned = _spawnPane(projectDir, handoffFile, paneId);
    return { spawned, armed: false, windowId: "", pane: true, paneId };
  }
  // Hosted pane (#5643): the pane IS the successor surface — no window is resolved, spawned, or
  // armed for closing. The detached driver replaces the session at the turn boundary.
  if (_hasPane(basename(projectDir))) {
    const spawned = _spawnPane(projectDir, handoffFile);
    return { spawned, armed: false, windowId: "", pane: true };
  }
  const { windowId, tty } = _resolveWindow();   // original window FIRST, while it's still frontmost
  const spawned = _spawnFresh(projectDir);
  if (!spawned) return { spawned: false, armed: false, windowId: "" };
  const armed = windowId ? _armClose(handoffFile, windowId, tty, conf) : false;
  return { spawned, armed, windowId };
}

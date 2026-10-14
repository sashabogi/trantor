// #8234: seat turn rows carried tokens 0 for every CLI that prints no usage line (the opencode
// family, dsh) — a ledger that records that a turn happened, never what it cost. The counts live
// in each provider's OWN session record; read them there, never from stdout.
// Usage shape: { input, output, cacheRead, cacheWrite } — null means "could not read", never 0.
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

export function usageTotal(u) {
  if (!u) return 0;
  return (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
}

// Absent = the provider did not report this field (0); present but not a non-negative integer =
// a corrupt read, which poisons the whole sum to null.
const field = (v) => {
  if (v === "" || v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
};
const blank = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

// ---- opencode: per-message usage in opencode.db, message.data JSON on assistant rows ----------
// The reader emits one `input|output|cacheRead|cacheWrite` row per in-window assistant message;
// this parser sums them. No rows at all = unknown, not zero.
export function sumOcRows(text) {
  const rows = String(text || "").split("\n").filter((l) => l.trim() !== "");
  if (!rows.length) return null;
  const sum = blank();
  for (const line of rows) {
    const cols = line.split("|");
    if (cols.length !== 4) return null;
    const vals = cols.map(field);
    if (vals.some((v) => v === null)) return null;
    sum.input += vals[0]; sum.output += vals[1]; sum.cacheRead += vals[2]; sum.cacheWrite += vals[3];
  }
  return sum;
}

// The one sqlite read, ocSid's mechanics exactly: sqlite3 CLI, -readonly, fail-open. Window is
// the turn (a resumed session's older messages carry older time_created values and drop out).
export function ocTurnUsage(dbPath, sessionId, sinceMs, untilMs, run = spawnSync) {
  if (!dbPath || !/^ses_[A-Za-z0-9]+$/.test(String(sessionId || ""))) return null;
  if (![sinceMs, untilMs].every(Number.isFinite) || untilMs < sinceMs) return null;
  const q = `SELECT json_extract(data,'$.tokens.input'), json_extract(data,'$.tokens.output'),`
    + ` json_extract(data,'$.tokens.cache.read'), json_extract(data,'$.tokens.cache.write')`
    + ` FROM message WHERE session_id='${String(sessionId).replaceAll("'", "''")}'`
    + ` AND json_extract(data,'$.role')='assistant'`
    + ` AND time_created>=${Math.floor(sinceMs)} AND time_created<=${Math.ceil(untilMs)};`;
  let r;
  try { r = run("sqlite3", ["-readonly", dbPath, q], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }); }
  catch { return null; }
  if (!r || r.error || r.status !== 0) return null;
  return sumOcRows(r.stdout);
}

// ---- dsh: usage rides assistant/message events in session.jsonl.zstd ---------------------------
const USAGE_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];
// dsh logs every step's usage TWICE (assistant/chunk and assistant/message carry the same
// numbers), so only the assistant/message copy counts — the chunk copy would bill double. The
// session's own turn counter is unrelated to the runner's, so the time window is the only filter.
export function dshUsageFromEvent(ev) {
  const u = ev && ev.type === "assistant/message" && ev.data ? ev.data.usage : null;
  // A usage RECORD carries at least one of the four counts; anything else (null, an array, a
  // bare number from a mangled log) is not one and drops out.
  if (!u || !USAGE_KEYS.some((k) => Object.prototype.hasOwnProperty.call(u, k))) return null;
  const g = (k) => { const n = Number(u[k]); return Number.isFinite(n) && n >= 0 ? n : 0; };
  return { input: g("inputTokens"), output: g("outputTokens"), cacheRead: g("cacheReadTokens"), cacheWrite: g("cacheWriteTokens") };
}

export function sumDshLog(text, sinceMs, untilMs) {
  let sum = null;
  for (const line of String(text || "").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let ev; try { ev = JSON.parse(s); } catch { continue; }
    const t = Number(ev.time);
    if (!Number.isFinite(t) || t < sinceMs || t > untilMs) continue;
    const u = dshUsageFromEvent(ev);
    if (!u) continue;
    if (!sum) sum = blank();
    sum.input += u.input; sum.output += u.output; sum.cacheRead += u.cacheRead; sum.cacheWrite += u.cacheWrite;
  }
  return sum;
}

// dsh names a session dir after the cwd it ran in, "/" spelled "-" and a trailing "/" added
// before the wrap: /a/b/dsh -> --a-b-dsh-- (observed on live ~/.dsh/sessions dirs).
export const dshSessionDirName = (cwd) => `-${String(cwd + "/").replaceAll("/", "-")}-`;

// Whether dsh resumed or started fresh is its own business, so scan every session log for this
// cwd and keep only in-window events. A log last written before the window opened can hold none.
export function dshTurnUsage(sessionsRoot, cwd, sinceMs, untilMs, run = spawnSync) {
  if (!sessionsRoot || !cwd || ![sinceMs, untilMs].every(Number.isFinite) || untilMs < sinceMs) return null;
  const dir = join(sessionsRoot, dshSessionDirName(cwd));
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  const sum = blank();
  let found = false;
  for (const name of names) {
    if (!name.startsWith("session-")) continue;
    const f = join(dir, name, "session.jsonl.zstd");
    let mtime;
    try { mtime = statSync(f).mtimeMs; } catch { continue; }
    if (mtime < sinceMs) continue;
    let r;
    try { r = run("zstd", ["-dc", f], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000, maxBuffer: 64 * 1024 * 1024 }); }
    catch { continue; }
    if (!r || r.status !== 0) continue;
    const s = sumDshLog(r.stdout, sinceMs, untilMs);
    if (!s) continue;
    found = true;
    sum.input += s.input; sum.output += s.output; sum.cacheRead += s.cacheRead; sum.cacheWrite += s.cacheWrite;
  }
  return found ? sum : null;
}

// ---- #11855: the LAST step's processed input, read from each harness's own session record ----
// null = no readable record; the card context cap never trips blind.

// Processed input a step re-read: fresh input + cache read + cache write.
export const processedInput = (u) => (u ? (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) : 0);

const readdirMaybe = (d) => { try { return readdirSync(d); } catch { return []; } };
const inWindow = (t, sinceMs) => Number.isFinite(t) && t >= sinceMs;
const realOr = (p) => { try { return realpathSync(p); } catch { return String(p || ""); } };

// Last `maxBytes` of a file as lines (a cut first line dropped): usage rows sit at the end.
function tailLines(path, maxBytes = 262144) {
  let fd;
  try { fd = openSync(path, "r"); } catch { return []; }
  try {
    const size = statSync(path).size;
    const off = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(Math.min(size, maxBytes));
    readSync(fd, buf, 0, buf.length, off);
    const lines = buf.toString("utf8").split("\n");
    if (off > 0) lines.shift();
    return lines;
  } catch { return []; }
  finally { try { closeSync(fd); } catch {} }
}

// codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, local-date dirs. A resumed session keeps
// appending to its ORIGINAL file, so the last `lookbackDays` of dirs are scanned, and the file is
// matched to the seat by the session_meta record's cwd. input_tokens already includes the cached
// part, so it is split to keep processedInput from counting the cache twice.
export function codexRolloutCwd(file) {
  let fd;
  try { fd = openSync(file, "r"); } catch { return null; }
  try {
    const buf = Buffer.alloc(8192);
    const m = buf.toString("utf8", 0, readSync(fd, buf, 0, 8192, 0)).match(/^\{"timestamp":"[^"]*"[^\n]*?"type":"session_meta"[^\n]*?"cwd":("(?:[^"\\]|\\.)*")/);
    return m ? JSON.parse(m[1]) : null;
  } catch { return null; }
  finally { try { closeSync(fd); } catch {} }
}
export function codexStepInput(sessionsRoot, sinceMs, cwd, { nowMs = Date.now(), lookbackDays = 14 } = {}) {
  if (!sessionsRoot || !cwd || !Number.isFinite(sinceMs)) return null;
  const want = realOr(cwd), pad = (n) => String(n).padStart(2, "0");
  let newest = null;
  for (let i = -1; i < lookbackDays; i++) {
    const day = new Date(nowMs - i * 86400000);
    const dir = join(sessionsRoot, String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
    for (const n of readdirMaybe(dir)) {
      if (!n.startsWith("rollout-") || !n.endsWith(".jsonl")) continue;
      const f = join(dir, n);
      let mt; try { mt = statSync(f).mtimeMs; } catch { continue; }
      if (mt < sinceMs || (newest && mt <= newest.mt)) continue;
      const c = codexRolloutCwd(f);
      if (c && realOr(c) === want) newest = { f, mt };
    }
  }
  if (!newest) return null;
  let last = null;
  for (const line of tailLines(newest.f)) {
    const s = line.trim(); if (!s) continue;
    let ev; try { ev = JSON.parse(s); } catch { continue; }
    if (ev?.payload?.type !== "token_count") continue;
    if (!inWindow(Date.parse(ev.timestamp || ""), sinceMs)) continue;
    const u = ev.payload?.info?.last_token_usage;
    if (u) last = u;
  }
  if (!last) return null;
  const inp = field(last.input_tokens), cached = field(last.cached_input_tokens), out = field(last.output_tokens);
  if (inp === null || cached === null || out === null) return null;
  return { input: Math.max(0, inp - cached), output: out, cacheRead: cached, cacheWrite: 0 };
}

// kimi: ~/.kimi-code/sessions/<wd>/<sid>/agents/main/wire.jsonl, found by the runner's sid (the
// printed `kimi -r <sid>` id) so a sibling seat's wire is never read. One usage.record per step.
export function kimiStepInput(sessionsRoot, sid, sinceMs) {
  if (!sessionsRoot || !sid || !Number.isFinite(sinceMs)) return null;
  let file = null;
  for (const wd of readdirMaybe(sessionsRoot)) {
    const f = join(sessionsRoot, wd, String(sid), "agents", "main", "wire.jsonl");
    try { if (statSync(f).isFile()) { file = f; break; } } catch {}
  }
  if (!file) return null;
  let last = null;
  for (const line of tailLines(file)) {
    const s = line.trim(); if (!s) continue;
    let ev; try { ev = JSON.parse(s); } catch { continue; }
    if (ev?.type !== "usage.record" || !ev.usage) continue;
    if (!inWindow(Number(ev.time), sinceMs)) continue;
    last = ev.usage;
  }
  if (!last) return null;
  const inp = field(last.inputOther), cr = field(last.inputCacheRead),
    cw = field(last.inputCacheCreation), out = field(last.output);
  if ([inp, cr, cw, out].some(v => v === null)) return null;
  return { input: inp, output: out, cacheRead: cr, cacheWrite: cw };
}

// claude: ~/.claude/projects/<cwd-slug>/*.jsonl (claudeTranscriptDir names the seat's dir), the
// newest transcript touched in the window; assistant rows carry message.usage. Subagent rows
// (isSidechain) are skipped. A 1MB tail, since an assistant line can carry long text.
export function claudeStepInput(transcriptDir, sinceMs) {
  if (!transcriptDir || !Number.isFinite(sinceMs)) return null;
  let newest = null;
  for (const n of readdirMaybe(transcriptDir)) {
    if (!n.endsWith(".jsonl")) continue;
    const f = join(transcriptDir, n);
    let mt; try { mt = statSync(f).mtimeMs; } catch { continue; }
    if (mt < sinceMs) continue;
    if (!newest || mt > newest.mt) newest = { f, mt };
  }
  if (!newest) return null;
  let last = null;
  for (const line of tailLines(newest.f, 1048576)) {
    const s = line.trim(); if (!s) continue;
    let ev; try { ev = JSON.parse(s); } catch { continue; }
    if (ev?.type !== "assistant" || ev.isSidechain) continue;
    const u = ev.message?.usage;
    if (!u) continue;
    if (!inWindow(Date.parse(ev.timestamp || ""), sinceMs)) continue;
    last = u;
  }
  if (!last) return null;
  const inp = field(last.input_tokens), cr = field(last.cache_read_input_tokens),
    cw = field(last.cache_creation_input_tokens), out = field(last.output_tokens);
  if ([inp, cr, cw, out].some(v => v === null)) return null;
  return { input: inp, output: out, cacheRead: cr, cacheWrite: cw };
}

// #8234: seat turn rows carried tokens 0 for every CLI that prints no usage line (the opencode
// family, dsh) — a ledger that records that a turn happened, never what it cost. The counts live
// in each provider's OWN session record; read them there, never from stdout.
// Usage shape: { input, output, cacheRead, cacheWrite } — null means "could not read", never 0.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
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

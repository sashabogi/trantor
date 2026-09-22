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

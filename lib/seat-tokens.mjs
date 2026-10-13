// #11559: the seat fleet's token burn was invisible — mined by hand from opencode's DB. This
// reader makes it a command: per-provider 30-day session/step/token totals, read-only, so a
// week-over-week comparison is one line. No DB at all is "no data", never zero. Read path
// mirrors lib/turn-usage.mjs (sqlite3 CLI, -readonly, fail-open).
import { spawnSync } from "node:child_process";

const num = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 ? n : 0; };

/// "provider/model" → "provider"; a bare model reads "?" so the row still groups. The 1.16.x DB
/// also stores whole JSON blobs ({"id":…,"providerID":…,"variant":…}) in session.model — the
/// provider then lives at $.providerID. The SQL mirrors this in CASE/WHEN form.
export function providerOf(model) {
  const s = String(model || "").trim();
  if (s.startsWith("{")) {
    try { return String(JSON.parse(s).providerID || "?"); } catch { return "?"; }
  }
  const at = s.indexOf("/");
  return at > 0 ? s.slice(0, at) : "?";
}

const PROVIDER_SQL = (col) => `CASE WHEN substr(${col},1,1)='{' THEN COALESCE(json_extract(${col},'$.providerID'),'?')`
  + ` WHEN instr(${col},'/')>1 THEN substr(${col},1,instr(${col},'/')-1) ELSE '?' END`;

export const SESSIONS_SQL = (sinceMs) => `SELECT ${SESSION_COLS} FROM session`
  + ` WHERE time_updated>=${Math.floor(sinceMs)} GROUP BY p ORDER BY total DESC;`;
const SESSION_COLS = `${PROVIDER_SQL("model")} AS p, COUNT(*) AS sessions,`
  + ` COALESCE(SUM(tokens_input),0), COALESCE(SUM(tokens_output),0), COALESCE(SUM(tokens_cache_read),0),`
  + ` COALESCE(SUM(tokens_cache_write),0), COALESCE(SUM(cost),0), COALESCE(MIN(time_created),0),`
  + ` COALESCE(MAX(time_updated),0), COALESCE(SUM(tokens_input+tokens_output+tokens_cache_read+tokens_cache_write),0) AS total`;

export const STEPS_SQL = (sinceMs) => `SELECT ${PROVIDER_SQL("s.model")} AS p,`
  + ` COUNT(m.id), COALESCE(MAX(json_extract(m.data,'$.tokens.input')),0)`
  + ` FROM message m JOIN session s ON s.id=m.session_id`
  + ` WHERE json_extract(m.data,'$.role')='assistant' AND m.time_created>=${Math.floor(sinceMs)} GROUP BY p;`;

const pipeRows = (text, cols) => String(text || "").split("\n").filter((l) => l.trim() !== "")
  .map((line) => {
    const parts = line.split("|");
    return parts.length === cols ? parts : null;
  })
  .filter(Boolean);

/// { provider, sessions, input, output, cacheRead, cacheWrite, cost, firstAt, lastAt, tokens,
///   steps, peakInput } per provider, tokens descending. [] when both queries return nothing —
/// an empty fleet and an unreadable DB print the same "no data" line, never zeros that lie.
export function seatTokensReport({ dbPath, sinceMs, run = spawnSync } = {}) {
  if (!dbPath || !Number.isFinite(sinceMs)) return [];
  const q = (sql) => {
    let r;
    try { r = run("sqlite3", ["-readonly", dbPath, sql], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }); }
    catch { return null; }
    return !r || r.error || r.status !== 0 ? null : r.stdout;
  };
  const sessions = pipeRows(q(SESSIONS_SQL(sinceMs)), 10);
  const steps = pipeRows(q(STEPS_SQL(sinceMs)), 3);
  const byProvider = new Map(sessions.map((c) => [c[0], {
    provider: c[0],
    sessions: num(c[1]),
    input: num(c[2]), output: num(c[3]), cacheRead: num(c[4]), cacheWrite: num(c[5]),
    cost: Number(c[6]) || 0,
    firstAt: num(c[7]), lastAt: num(c[8]),
    tokens: num(c[9]),
    steps: 0, peakInput: 0,
  }]));
  for (const [p, count, peak] of steps) {
    const row = byProvider.get(p);
    if (!row) continue;
    row.steps = num(count);
    row.peakInput = num(peak);
  }
  return [...byProvider.values()].sort((a, b) => b.tokens - a.tokens);
}

// CLI-owned records let read-only turns and their sub-agents prove liveness (#10497).
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const canonical = p => { try { return realpathSync(p); } catch { return p; } };
const sql = s => `'${String(s).replaceAll("'", "''")}'`;
const entries = p => { try { return readdirSync(p, { withFileTypes: true }); } catch { return []; } };
const mtime = p => { try { return statSync(p).mtimeMs; } catch { return 0; } };
function logTime(dir, budget = { left: 20000 }) {
  let best = 0;
  for (const e of entries(dir)) {
    if (--budget.left < 0) break;
    const path = join(dir, e.name);
    if (e.isDirectory()) best = Math.max(best, logTime(path, budget));
    else if (e.name.endsWith(".jsonl")) best = Math.max(best, mtime(path));
  }
  return best;
}
function query(db, statement) {
  try {
    const r = spawnSync("sqlite3", ["-readonly", db, statement], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000,
    });
    return r.status === 0 ? r.stdout.trim() : "";
  } catch { return ""; }
}

// Pin the root once discovered. A fresh root must have been created during this turn;
// a resumed root is supplied by the runner. Never use global DB/WAL mtimes.
export function sessionActivityReader({ kind, sid = "", db, workDir, home, startedAt, transcriptDir }) {
  let root = sid, logDir = "";
  const cwd = canonical(workDir);
  return () => {
    if (kind === "opencode") {
      if (!root) root = query(db, `SELECT id FROM session WHERE directory IN (${sql(workDir)},${sql(cwd)})`
        + ` AND parent_id IS NULL AND time_created>=${Math.floor(startedAt)} ORDER BY time_created DESC LIMIT 1;`);
      if (!/^ses_[A-Za-z0-9]+$/.test(root)) return 0;
      const value = query(db, `WITH RECURSIVE own(id) AS (SELECT id FROM session WHERE id=${sql(root)}`
        + ` UNION SELECT s.id FROM session s JOIN own ON s.parent_id=own.id)`
        + ` SELECT MAX(t) FROM (SELECT MAX(time_created,time_updated) t FROM message WHERE session_id IN (SELECT id FROM own)`
        + ` UNION ALL SELECT MAX(time_created,time_updated) t FROM part WHERE session_id IN (SELECT id FROM own));`);
      return Number(value) || 0;
    }
    if (kind === "claude") {
      if (!root) {
        const newest = entries(transcriptDir).filter(e => e.isFile() && e.name.endsWith(".jsonl"))
          .map(e => ({ name: e.name, ts: mtime(join(transcriptDir, e.name)) }))
          .filter(e => e.ts >= startedAt).sort((a, b) => b.ts - a.ts)[0];
        if (newest) root = newest.name.slice(0, -6);
      }
      if (!root || root.includes("/")) return 0;
      return Math.max(mtime(join(transcriptDir, `${root}.jsonl`)), logTime(join(transcriptDir, root)));
    }
    if (kind !== "kimi") return 0;
    if (!logDir) {
      // kimi-code indexes the actual workdir and session directory; avoid guessing its hash.
      try {
        const rows = readFileSync(join(home, ".kimi-code", "session_index.jsonl"), "utf8").trim().split("\n");
        for (const line of rows.reverse()) {
          let row; try { row = JSON.parse(line); } catch { continue; }
          if (canonical(row.workDir || "") !== cwd || !row.sessionDir || (root && row.sessionId !== root)) continue;
          if (!root && mtime(row.sessionDir) < startedAt) continue;
          root = row.sessionId; logDir = row.sessionDir; break;
        }
      } catch {}
      // Python kimi-cli uses md5(canonical cwd)/session-id.
      if (!logDir) {
        const parent = join(home, ".kimi", "sessions", createHash("md5").update(cwd).digest("hex"));
        if (root && !root.includes("/")) logDir = join(parent, root);
        else {
          const newest = entries(parent).filter(e => e.isDirectory()).map(e => ({ name: e.name, ts: mtime(join(parent, e.name)) }))
            .filter(e => e.ts >= startedAt).sort((a, b) => b.ts - a.ts)[0];
          if (newest) { root = newest.name; logDir = join(parent, root); }
        }
      }
    }
    return logDir ? logTime(logDir) : 0;
  };
}

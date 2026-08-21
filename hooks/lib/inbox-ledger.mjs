// The local inbox ledger every reader in a session shares (inbox-deliver, stop-inbox, sessionstart, mcp).
//
// Why this exists (2026-08-20, crebral-health #7282): a reader's FIRST poll used to seed its cursor to
// "now" — now being whenever that first poll happened to SUCCEED. The first PostToolUse poll of a fresh
// session timed out (1.5s budget, first-run enrollment on a remote hub), wrote nothing, and the seed
// slid to the next tool call 33 minutes later. Everything that arrived in between was treated as
// backlog: never shown, yet marked delivered on the hub, so nothing escalated either. The session
// honestly said "no new messages" to the very nudge sent about #7282.
//
// The invariant now: the seed anchors to SESSION START, never to the first successful call. A start
// stamp is written locally before any network I/O (it cannot fail), and a late seed uses it to split
// "backlog the session was never meant to see" from "messages that arrived on its watch".
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function ledgerPaths(session, instanceId, dir = join(homedir(), ".agent-bus")) {
  const safe = (session + (instanceId ? `@${String(instanceId).slice(0, 8)}` : "")).replace(/[^A-Za-z0-9_.@-]/g, "_");
  return {
    safe, dir,
    cursorFile: join(dir, `inbox-cursor-${safe}.id`),
    startFile: join(dir, `inbox-start-${safe}.ts`),
    pollStamp: join(dir, `inbox-poll-${safe}.stamp`),
  };
}

// Session start as this ledger knows it: the stamp if one exists, else now (written for next time).
export function ensureStart(paths, now = Date.now()) {
  try {
    if (existsSync(paths.startFile)) {
      const t = Number(readFileSync(paths.startFile, "utf8"));
      if (Number.isFinite(t) && t > 0) return t;
    }
  } catch {}
  try { mkdirSync(paths.dir, { recursive: true }); writeFileSync(paths.startFile, String(now)); } catch {}
  return now;
}

// The cursor a fresh ledger starts from: the newest message that predates session start. Anything
// after it is on this session's watch and gets delivered by the normal path.
export function anchorCursor(messages, startTs) {
  let anchor = 0;
  for (const m of messages || []) {
    if (Number(m.ts) <= startTs && Number(m.id) > anchor) anchor = Number(m.id);
  }
  return anchor;
}

export function readCursor(paths) {
  try { return Number(readFileSync(paths.cursorFile, "utf8")) || 0; } catch { return 0; }
}

export function writeCursor(paths, cursor) {
  try { mkdirSync(paths.dir, { recursive: true }); writeFileSync(paths.cursorFile, String(cursor)); } catch {}
}

// trantor — the turn-row shipper (#14067, docs/CONTRACT-turn-telemetry.md): the local jsonl stays the
// write-ahead log; this lib drains it to the hub over the signed bus, oldest first, behind a
// byte-offset cursor. At-least-once: the cursor only moves after a 200, so an unreachable hub queues
// rows on disk instead of losing them, and a retry re-posts rows the hub dedupes by id.
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { signedPost } from "../hooks/lib/api.mjs";
import { asString } from "./decode.mjs";

const logsDir = () => join(process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus"), "logs");
const BATCH = 100;
export const VERDICT_MAX = 600;

/** The duplicate key: first 32 hex of sha256 over persona, project, ts, turn. */
export function turnRowId(persona, project, ts, turn) {
  return createHash("sha256").update(`${persona}\n${project}\n${Number(ts)}\n${Number(turn)}`).digest("hex").slice(0, 32);
}

/** Only a row with a positive integer `turn` is a turn. Boot rows and text notes are never turns. */
export function isTurnRow(rec) {
  return !!rec && Number.isInteger(rec.turn) && rec.turn > 0;
}

/**
 * The three fields every written turn row gains (#14067): the dedupe id, the schema version, the
 * machine label — with the verdict cut to the contract's 600 characters. Non-turn rows pass through.
 */
export function completeTurnRow(rec, machine = "") {
  if (!isTurnRow(rec)) return rec;
  // machine is always present, "" when this machine has no label: the hub takes a string, not a missing key.
  const row = { ...rec, id: turnRowId(rec.persona, rec.project, rec.ts, rec.turn), v: 1, machine: String(machine || "") };
  if (row.verdict !== undefined) row.verdict = String(row.verdict).slice(0, VERDICT_MAX);
  return row;
}

const fileFor = (persona, project) => join(logsDir(), `${persona}-${project}.jsonl`);
export const telemetryDir = logsDir;
export const telemetryFileFor = fileFor;
const cursorFor = (persona, project) => join(logsDir(), `.shipped-${persona}-${project}`);
// The episode marker outlives the process: a boot that finally ships after the previous runner's
// failures is a recovery too, and the drill expects its one log line.
const downFor = (persona, project) => join(logsDir(), `.shipped-${persona}-${project}.down`);

const episodes = new Set();
const tails = new Map();

function episodeStart(persona, project, reason, log) {
  const key = `${persona}:${project}`;
  if (episodes.has(key)) return;
  episodes.add(key);
  try { writeFileSync(downFor(persona, project), String(Date.now())); } catch {}
  log(`could not report turns to the hub (${reason}) — rows stay queued and retry at the next turn or boot`);
}

function episodeEnd(persona, project, log) {
  const key = `${persona}:${project}`;
  let marked = false;
  try { marked = existsSync(downFor(persona, project)); } catch {}
  if (!episodes.has(key) && !marked) return;
  episodes.delete(key);
  try { unlinkSync(downFor(persona, project)); } catch {}
  log("turn reporting recovered — queued rows shipped");
}

// Serialised per seat: a boot ship and a turn ship never race one cursor. At-least-once would
// forgive the overlap; the queue makes it rare instead of routine. Never rejects.
export function shipTurnRows({ persona, project, hub = "", log = () => {}, timeoutMs = 2000, fromStart = false, machine = "" }) {
  const key = `${persona}:${project}`;
  const drainOne = () => drain({ persona, project, hub, log, timeoutMs, fromStart, machine });
  const run = (tails.get(key) || Promise.resolve()).then(drainOne, drainOne);
  tails.set(key, run);
  run.then(() => { if (tails.get(key) === run) tails.delete(key); });
  return run;
}

function writeCursor(persona, project, offset) {
  // A torn write can only leave a smaller number (re-ship, deduped) — never a skipped row.
  try { writeFileSync(cursorFor(persona, project), `${offset}\n`); } catch {}
}

function reasonOf(r) {
  if (r?.status) return `hub answered ${r.status}`;
  return r?.reason || "hub unreachable";
}

// The unshipped tail of one seat's jsonl: complete lines only. A partial last line (the writer
// crashed mid-append) is neither shipped nor consumed — the cursor stops before it.
function readTail(file, start) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    // A cursor past EOF means the file was rotated or recreated: ship from the beginning rather
    // than sit above the new content forever.
    const from = start > size ? 0 : start;
    const buf = Buffer.alloc(size - from);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    const lines = [];
    let at = 0;
    while (at < got) {
      const nl = buf.indexOf(10, at);
      if (nl < 0) break;
      lines.push({ text: buf.toString("utf8", at, nl).replace(/\r$/, ""), end: from + nl + 1 });
      at = nl + 1;
    }
    return { lines, endOfComplete: lines.length ? lines.at(-1).end : from };
  } finally { closeSync(fd); }
}

async function drain({ persona, project, hub, log, timeoutMs, fromStart, machine }) {
  const totals = { ok: true, stored: 0, duplicates: 0, dropped: 0, shipped: 0, requests: 0, error: "" };
  const file = fileFor(persona, project);
  try {
    if (!existsSync(file)) return totals;
    let start = 0;
    if (!fromStart) {
      try { start = Number(readFileSync(cursorFor(persona, project), "utf8")); } catch {}
      if (!Number.isInteger(start) || start < 0) start = 0;
    }
    const { lines, endOfComplete } = readTail(file, start);
    const entries = [];
    for (const line of lines) {
      let rec = null;
      try { rec = JSON.parse(line.text); } catch { continue; }   // a corrupt line has no contract; it is consumed, never shipped
      if (!isTurnRow(rec)) continue;                              // boot rows and text notes are never turns
      if (!rec.id) rec.id = turnRowId(rec.persona, rec.project, rec.ts, rec.turn);   // history rows pre-date the id
      // History rows also pre-date v and machine, and the hub accepts only v 1 with a string machine.
      if (rec.v !== 1) rec.v = 1;
      rec.machine = asString(rec.machine) || String(machine || "");
      if (rec.verdict !== undefined && String(rec.verdict).length > VERDICT_MAX) rec.verdict = String(rec.verdict).slice(0, VERDICT_MAX);
      entries.push({ row: rec, end: line.end });
    }
    const path = hub ? `${hub.replace(/\/+$/, "")}/telemetry/turns` : "/telemetry/turns";
    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH);
      const r = await signedPost(path, { rows: batch.map(e => e.row) },
        { timeoutMs, session: `${persona}:${project}`, project });
      if (!r.ok) {
        totals.ok = false;
        totals.error = reasonOf(r);
        episodeStart(persona, project, totals.error, log);
        return totals;
      }
      const reply = r.json || {};
      totals.stored += Number(reply.stored) || 0;
      totals.duplicates += Number(reply.duplicates) || 0;
      totals.dropped += Number(reply.dropped) || 0;
      totals.shipped += batch.length;
      totals.requests += 1;
      writeCursor(persona, project, batch.at(-1).end);
      episodeEnd(persona, project, log);
    }
    // Consumed-but-unshipped lines (boot rows, text notes, a re-read gap) advance the cursor too —
    // they are never shippable, so holding them only re-reads them every turn.
    writeCursor(persona, project, endOfComplete);
    return totals;
  } catch (e) {
    if (e?.code === "ENOENT") return totals;   // the log was rotated away between the check and the read
    totals.ok = false;
    totals.error = String(e?.message || e);
    episodeStart(persona, project, totals.error, log);
    return totals;
  }
}

/**
 * The seat a telemetry file belongs to, read from its rows (a persona or project may contain a
 * hyphen, so the filename alone cannot split). null when no row names a seat.
 */
export function seatForTelemetryFile(file) {
  let source = "";
  try { source = readFileSync(file, "utf8"); } catch { return null; }
  for (const line of source.split("\n")) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      const persona = asString(rec?.persona), project = asString(rec?.project);
      if (persona && project) return { persona, project };
    } catch {}
  }
  return null;
}

/** Every telemetry file in the logs folder, oldest-name first — what `--all` ships. */
export function telemetryFiles() {
  try { return readdirSync(logsDir()).filter(f => f.endsWith(".jsonl")).sort(); } catch { return []; }
}

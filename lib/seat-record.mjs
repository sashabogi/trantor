// #7762: the seat record is DERIVED from card history and the runner's ledger, never a store, so
// a seat benched by relay_advise can always be un-benched. Rules: docs/CONTRACT-lib.md, Crew turn
// policy and failure classification.
import { readFileSync, writeFileSync, renameSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { busDir } from "./project.mjs";

export const RECORD_LIMIT = 20;
export const STRIKE = 3;

// The roster token an assignee string routes by: "kimi:trantor" → "kimi".
export const seatLabel = (assignee) => String(assignee || "").split(":")[0];

const BAD_OUTCOMES = new Set(["empty", "bounced"]);
// Turn outcomes that count as the seat having produced something. "asked" (#7756) is a real
// answer-shaped turn, not a silent one; cut/stalled/empty produced nothing by definition.
const PRODUCTIVE_OUTCOMES = new Set(["completed", "asked"]);

export function resetsPathFor() {
  return join(busDir(), "seat-record-resets.json");
}

// Pure. cards = full /tasks rows (history + log included — never fields=slim), events = /events
// type=moved rows (bounce evidence for cards that aged off the board), ledger = runner jsonl
// rows from every <seat>-<project>.jsonl, resets = { <seatLabel>: ts } for THIS project.
export function computeSeatRecord({ cards = [], events = [], ledger = [], resets = {}, limit = RECORD_LIMIT } = {}) {
  const byCard = new Map();
  const ensure = (id) => {
    let c = byCard.get(id);
    if (!c) { c = { id, title: "", difficulty: "", seat: "", status: "", ts: 0, history: [], log: [] }; byCard.set(id, c); }
    return c;
  };
  for (const t of cards) {
    const c = ensure(t.id);
    c.title = t.title || c.title;
    c.difficulty = t.difficulty || c.difficulty;
    c.seat = seatLabel(t.assignee) || c.seat;
    c.status = t.status || c.status;
    c.ts = Math.max(c.ts, Number(t.updated || t.ts) || 0);
    if (Array.isArray(t.history)) c.history.push(...t.history);
    if (Array.isArray(t.log)) c.log.push(...t.log);
  }
  // Moved events re-state what a live card's history already says (idempotent — classification
  // is boolean) and are the only trail left for a card that aged out of the board's task cap.
  for (const e of events) {
    if (e?.type !== "moved" || !Number.isInteger(e.taskId)) continue;
    const c = ensure(e.taskId);
    c.title = c.title || e.title || "";
    c.difficulty = c.difficulty || e.difficulty || "";
    c.seat = c.seat || seatLabel(e.assignee);
    c.ts = Math.max(c.ts, Number(e.ts) || 0);
    c.history.push({ from: e.from, to: e.to, by: e.by, ts: e.ts });
    if (e.to === "done") c.status = "done";
  }
  const rows = ledger.filter(r => r && Number.isInteger(r.card) && r.card > 0);
  const seats = {};
  for (const c of byCard.values()) {
    if (!c.seat) continue;                       // unassigned cards say nothing about a seat
    const resetTs = Number(resets[c.seat]) || 0;
    const seatRows = rows.filter(r => seatLabel(r.agent) === c.seat && r.card === c.id && (Number(r.ts) || 0) > resetTs);
    const bounced =
      c.history.some(h => h.from === "testing" && h.to === "doing" && h.by && seatLabel(h.by) !== c.seat) ||
      c.log.some(l => /^HOLLOW:/.test(String(l?.text || ""))) ||
      c.history.some(h => /^HOLLOW:/.test(String(h?.note || "")));
    let outcome = null;
    if (bounced) outcome = "bounced";
    else if (c.status === "done") outcome = "completed";
    else if (seatRows.length && seatRows.every(r => !PRODUCTIVE_OUTCOMES.has(r.outcome))) outcome = "empty";
    if (!outcome) continue;                      // in flight or no evidence — not a record entry
    const ts = Math.max(c.ts, ...c.history.map(h => Number(h.ts) || 0), ...c.log.map(l => Number(l.ts) || 0), ...seatRows.map(r => Number(r.ts) || 0), 0);
    if (ts <= resetTs) continue;                 // a reset wipes everything it postdates
    const s = (seats[c.seat] ||= { cards: [], wastedTokens: 0 });
    s.cards.push({ id: c.id, title: c.title, difficulty: c.difficulty, outcome, ts });
    if (BAD_OUTCOMES.has(outcome)) s.wastedTokens += seatRows.reduce((sum, r) => sum + (Number(r.tokens) || 0), 0);
  }
  for (const s of Object.values(seats)) {
    s.cards.sort((a, b) => a.ts - b.ts);
    if (s.cards.length > limit) s.cards.splice(0, s.cards.length - limit);
  }
  return { seats };
}

// The bench rule: the seat's last STRIKE cards AT THIS DIFFICULTY were all empty/bounced.
// Fewer than STRIKE cards is insufficient evidence — a new seat is never benched on one bad card.
export function benchedAt(record, seat, difficulty) {
  const atDiff = (record?.seats?.[seat]?.cards || []).filter(c => c.difficulty === difficulty).slice(-STRIKE);
  if (atDiff.length < STRIKE || !atDiff.every(c => BAD_OUTCOMES.has(c.outcome))) return null;
  return { streak: atDiff.map(c => c.outcome), cardIds: atDiff.map(c => c.id), wastedTokens: record.seats[seat].wastedTokens };
}

const readJson = (p, fb) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fb; } };

// Reads the three live sources for `project` through hooks/lib/api.mjs signedGet (fail-open: any
// unreachable piece yields an empty record — the advisor then routes exactly as before #7762).
// `get` is injectable so the drill never touches a hub.
export async function loadSeatRecord({ project, get, logDir, resetsPath } = {}) {
  if (!project) return { seats: {} };
  if (!get) {
    try {
      const { signedGet } = await import("../hooks/lib/api.mjs");
      get = (path) => signedGet(path, { project });
    } catch { return { seats: {} }; }
  }
  const [tasksR, eventsR] = await Promise.all([
    get(`/tasks?project=${encodeURIComponent(project)}`),
    get(`/events?project=${encodeURIComponent(project)}&type=moved&limit=2000`),
  ]);
  const cards = tasksR?.ok && Array.isArray(tasksR.json?.tasks) ? tasksR.json.tasks : [];
  const events = eventsR?.ok && Array.isArray(eventsR.json?.events) ? eventsR.json.events : [];
  const dir = logDir || join(homedir(), ".agent-bus", "logs");
  const ledger = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(`-${project}.jsonl`)) continue;
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { ledger.push(JSON.parse(line)); } catch {}
      }
    }
  } catch {}
  const resets = readJson(resetsPath || resetsPathFor(), {})?.[project] || {};
  return computeSeatRecord({ cards, events, ledger, resets });
}

// The manual forgiveness path. Stamps now() for <seat> in <project>; evidence at or before the
// stamp stops counting. Atomic write — a crash mid-reset must not corrupt every other project's.
export function resetSeat({ project, seat, resetsPath, now = Date.now() } = {}) {
  const p = resetsPath || resetsPathFor();
  const all = readJson(p, {});
  (all[project] ||= {})[seat] = now;
  try {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    renameSync(tmp, p);
    return true;
  } catch { return false; }
}

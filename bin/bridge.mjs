#!/usr/bin/env node
// trantor bridge — TEMPORARY card mirror between two hubs for ONE project.
//
// Exists for the split-brain case: a crew bound to one hub while the project's canonical
// board lives on another (env-inherited RELAY_URL at `trantor up` time — 2026-08-14,
// crebral-health). Killing a working crew mid-build just to rebind it is worse than the
// split, so this process runs ALONGSIDE: no hub restart, no seat restart, additive only.
//
//   node bin/bridge.mjs <project> [--from <hubA>] [--to <hubB>] [--since <ms|ISO>]
//                       [--interval <sec>] [--once] [--map <file>]
//
//   forward (from → to): every card created/updated since --since mirrors + tracks.
//   reverse (to → from): OPEN cards (todo/doing/testing/failed) mirror so the crew's
//                        relay_board shows its assignments.
//   Mapped pairs sync STATUS + assignee both ways; on a same-tick conflict the card's
//   ORIGIN side wins. Mapping persists to disk, so restarts never duplicate.
//
// What it deliberately does NOT mirror: messages (duplicate delivery + prompt-injection
// surface) and presence (heartbeats must stay honest — a bridge that fakes liveness lies
// to the liveness doctrine). Cards attributed via `by` may flicker the seat "online" on
// the target for ONLINE_MS after a mirrored write; that tracks real seat activity closely
// enough to be acceptable for a temporary bridge.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { loadOrCreate } from "../lib/identity.mjs";
import { sfetchJson } from "../lib/signed-fetch.mjs";
import { resolveHub } from "../lib/project.mjs";

const argv = process.argv.slice(2);
const PROJECT = argv[0] && !argv[0].startsWith("--") ? argv[0] : "";
if (!PROJECT) { console.error("usage: bridge.mjs <project> [--from hub] [--to hub] [--since ms|ISO] [--interval sec] [--once]"); process.exit(1); }
const val = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

const BUS_DIR = process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus");
let config = {}; try { config = JSON.parse(readFileSync(join(BUS_DIR, "config.json"), "utf8")); } catch {}
const FROM = val("from", "http://127.0.0.1:4477");
const TO = val("to", resolveHub(PROJECT, {}));           // {}: never let this process's own env leak in
const SINCE = (() => { const s = val("since", "0"); const n = Number(s); return Number.isFinite(n) && n > 0 ? n : (Date.parse(s) || 0); })();
const INTERVAL = Math.max(2, Number(val("interval", 5))) * 1000;
const ONCE = argv.includes("--once");
const MAPFILE = val("map", join(BUS_DIR, `bridge-${PROJECT}.json`));
const OPEN = new Set(["todo", "doing", "testing", "failed"]);
// reverse direction only mirrors open cards TOUCHED recently — a split-brain bridge is for
// live coordination, not for pouring a months-old open backlog onto the crew's board.
const _rw = Number(val("reverse-window", 24));
const REVERSE_WINDOW_MS = (Number.isFinite(_rw) && _rw > 0 ? _rw : 24) * 3600 * 1000;

const id = loadOrCreate(config.ownerIdentity || "admin", "human");
const call = async (hub, method, path, payload) => {
  const r = await sfetchJson(`${hub}${path}`, { method, identity: id, payload, signal: AbortSignal.timeout(8000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`${hub}${path}: ${j.error || r.status}`);
  return j;
};

// pairs: [{ aId, bId, origin: "A"|"B", lastA, lastB }] — lastX is the updated-stamp we have
// already accounted for on that side (our own writes included, so they never echo back).
let map = { pairs: [] };
try { map = JSON.parse(readFileSync(MAPFILE, "utf8")); } catch {}
const saveMap = () => { try { mkdirSync(dirname(MAPFILE), { recursive: true }); writeFileSync(MAPFILE, JSON.stringify(map)); } catch {} };

const cardBody = (t) => ({ project: PROJECT, title: t.title, status: t.status, assignee: t.assignee || "",
  difficulty: t.difficulty || undefined, model: t.model || undefined, phase: t.phase || undefined,
  by: t.by || "", source: "bridge" });

async function tick() {
  const [a, b] = await Promise.all([call(FROM, "GET", `/tasks?project=${encodeURIComponent(PROJECT)}`),
                                    call(TO, "GET", `/tasks?project=${encodeURIComponent(PROJECT)}`)]);
  const A = new Map((a.tasks || []).map(t => [t.id, t]));
  const B = new Map((b.tasks || []).map(t => [t.id, t]));
  const mappedA = new Set(map.pairs.map(p => p.aId));
  const mappedB = new Set(map.pairs.map(p => p.bId));
  let created = 0, synced = 0, seeded = 0;

  // SEED: the hubs may share ancestry (one was migrated from the other), so the same card can
  // exist on both sides under the SAME id + title. Pair those instead of duplicating them.
  // Seeding is PASSIVE — long-diverged statuses are accepted as-is, never mass-rewritten —
  // EXCEPT a card the crew side touched after --since: that one is live work, and pushes.
  for (const t of A.values()) {
    if (mappedA.has(t.id)) continue;
    const twin = B.get(t.id);
    if (twin && !mappedB.has(twin.id) && twin.title === t.title) {
      const live = SINCE > 0 && (t.updated || 0) >= SINCE;
      map.pairs.push({ aId: t.id, bId: twin.id, origin: "A", lastA: live ? 0 : (t.updated || 0), lastB: twin.updated || 0 });
      mappedA.add(t.id); mappedB.add(twin.id); seeded++;
    }
  }

  // forward: new A-side cards since SINCE → create on B
  for (const t of A.values()) {
    if (mappedA.has(t.id) || (t.updated || t.ts || 0) < SINCE) continue;
    const r = await call(TO, "POST", "/task", cardBody(t));
    map.pairs.push({ aId: t.id, bId: r.task.id, origin: "A", lastA: t.updated || 0, lastB: r.task.updated || 0 });
    mappedA.add(t.id); mappedB.add(r.task.id); created++;
  }
  // reverse: recently-touched OPEN B-side cards → create on A (assignments reach the crew)
  for (const t of B.values()) {
    if (mappedB.has(t.id) || !OPEN.has(t.status) || (Date.now() - (t.updated || t.ts || 0)) > REVERSE_WINDOW_MS) continue;
    const r = await call(FROM, "POST", "/task", cardBody(t));
    map.pairs.push({ aId: r.task.id, bId: t.id, origin: "B", lastA: r.task.updated || 0, lastB: t.updated || 0 });
    mappedB.add(t.id); mappedA.add(r.task.id); created++;
  }
  // mapped pairs: status/assignee follow whichever side moved; origin wins a tie
  for (const p of map.pairs) {
    const ta = A.get(p.aId), tb = B.get(p.bId);
    if (!ta || !tb) continue;                            // deleted on one side: leave the other alone
    const aMoved = (ta.updated || 0) > p.lastA, bMoved = (tb.updated || 0) > p.lastB;
    const differs = ta.status !== tb.status || (ta.assignee || "") !== (tb.assignee || "");
    if (differs && (aMoved || bMoved)) {
      const aWins = aMoved && bMoved ? p.origin === "A" : aMoved;
      const [src, dstHub, dstId] = aWins ? [ta, TO, p.bId] : [tb, FROM, p.aId];
      // reassign:true — the bridge REPLICATES a hand-change that already happened on the source
      // hub; without the explicit marker the #5406 assignee-immutability guard would 409 every
      // cross-hub sync whose assignee moved (deepseek flagged this at review, 2026-08-31).
      const r = await call(dstHub, "POST", "/task/update", { id: dstId, status: src.status, assignee: src.assignee || "", reassign: true, by: src.by || "bridge" });
      if (aWins) { p.lastA = ta.updated || 0; p.lastB = r.task.updated || 0; }
      else { p.lastB = tb.updated || 0; p.lastA = r.task.updated || 0; }
      synced++;
    } else { p.lastA = Math.max(p.lastA, ta.updated || 0); p.lastB = Math.max(p.lastB, tb.updated || 0); }
  }
  saveMap();
  return { created, synced, seeded };
}

console.log(`[bridge] ${PROJECT}: ${FROM} <-> ${TO} · since ${SINCE ? new Date(SINCE).toISOString() : "epoch"} · map ${MAPFILE}`);
if (ONCE) {
  const r = await tick();
  console.log(`[bridge] tick: +${r.created} mirrored, ${r.synced} synced`);
} else {
  writeFileSync(join(BUS_DIR, `bridge-${PROJECT}.pid`), String(process.pid));
  let failures = 0;
  while (true) {
    try { const r = await tick(); failures = 0; if (r.created || r.synced) console.log(`[bridge] +${r.created} mirrored, ${r.synced} synced`); }
    catch (e) { if (++failures % 10 === 1) console.error(`[bridge] tick failed (${failures}x): ${e.message}`); }
    await new Promise(r => setTimeout(r, INTERVAL));
  }
}

#!/usr/bin/env node
// trantor — one-shot importer: bus.json → Postgres, per project.
//
//   node bin/migrate-store.mjs --source <bus.json> --projects a,b,c [--org local] [--dry] [--force]
//
// SAFETY CONTRACT, in order of importance:
//   1. The source file is opened READ-ONLY and never written. Run it against a COPY anyway.
//   2. IDEMPOTENT. Re-running must not duplicate. tasks/messages have natural primary keys
//      (org_id, id) so they take ON CONFLICT DO NOTHING. `events` does NOT — its id is a BIGSERIAL,
//      and the source events are only array-ordered, so there is no natural key to collide on and a
//      second run WOULD duplicate all of them. Guarded instead by a per-project marker in `kv`
//      (`migrated:<project>`); --force overrides, and then events for that project are deleted first
//      so the reimport stays exact rather than additive.
//   3. VERIFIED ROUND-TRIP. After import we read back from Postgres and compare per-project counts
//      and a checksum over card (id,status,title) — a count alone would not catch a truncated title
//      or a mangled status.
//
// Deliberately raw SQL rather than lib/store-pg.mjs: a one-shot importer wants exact control of
// ON CONFLICT and batching, and it must not inherit runtime semantics meant for a live hub.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";
import { CHANGE_CHANNEL } from "../lib/store-contract.mjs";

const argv = process.argv.slice(2);
const arg = (k, d = "") => { const i = argv.indexOf(`--${k}`); return i >= 0 ? (argv[i + 1] ?? "") : d; };
const has = (k) => argv.includes(`--${k}`);

const SOURCE   = arg("source", "");
const PROJECTS = arg("projects", "").split(",").map(s => s.trim()).filter(Boolean);
const ORG      = arg("org", "local");
const DRY      = has("dry");
const FORCE    = has("force");
const URL      = process.env.DATABASE_URL || process.env.RELAY_DATABASE_URL || "";

if (!SOURCE || !PROJECTS.length) {
  console.error("usage: migrate-store.mjs --source <bus.json> --projects a,b,c [--org local] [--dry] [--force]");
  process.exit(2);
}
if (!URL) { console.error("DATABASE_URL is not set"); process.exit(2); }

const src = JSON.parse(readFileSync(SOURCE, "utf8"));
const inScope = (p) => PROJECTS.includes(p);
const tasks    = (src.tasks    || []).filter(t => inScope(t.project));
const events   = (src.events   || src.cardEvents || []).filter(e => inScope(e.project));
const messages = (src.messages || []).filter(m => inScope(m.project));
const peers    = Object.entries(src.peers || {}).filter(([, p]) => inScope(p.project));

// Checksum over the fields that actually matter for a board, computed identically on both sides so
// source and destination are comparable. Sorted by id so row order can never affect the result.
const cardSum = (rows) => createHash("sha256").update(
  rows.map(r => `${r.id}|${r.status}|${r.title}`).sort().join("\n")
).digest("hex").slice(0, 16);

console.log(`source   : ${SOURCE}`);
console.log(`projects : ${PROJECTS.join(", ")}`);
console.log(`org      : ${ORG}${DRY ? "   [DRY RUN — no writes]" : ""}`);
console.log(`scoped   : ${tasks.length} cards · ${events.length} events · ${messages.length} messages · ${peers.length} peers`);
console.log(`checksum : ${cardSum(tasks)} (source)`);

const client = new pg.Client({ connectionString: URL });
await client.connect();

async function alreadyMigrated(project) {
  const r = await client.query("SELECT value FROM kv WHERE org_id=$1 AND key=$2", [ORG, `migrated:${project}`]);
  return r.rows[0]?.value || null;
}

let imported = { tasks: 0, events: 0, messages: 0, peers: 0 }, skipped = [];

for (const project of PROJECTS) {
  const prior = await alreadyMigrated(project);
  if (prior && !FORCE) { skipped.push(project); continue; }
  if (DRY) continue;

  await client.query("BEGIN");
  try {
    // --force = exact reimport, not an additive one. Only events need clearing; tasks/messages
    // collide on their natural keys and are simply left alone.
    if (prior && FORCE) await client.query("DELETE FROM events WHERE org_id=$1 AND project=$2", [ORG, project]);

    for (const t of tasks.filter(x => x.project === project)) {
      await client.query(
        `INSERT INTO tasks (id,org_id,project,title,status,assignee,source,difficulty,model,phase,cost_usd,deps,history,created,updated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (org_id,id) DO NOTHING`,
        [t.id, ORG, t.project ?? null, String(t.title ?? ""), String(t.status ?? "todo"), t.assignee ?? null,
         t.source ?? null, t.difficulty ?? null, t.model ?? null, t.phase ?? null, t.costUsd ?? null,
         JSON.stringify(t.deps ?? []), JSON.stringify(t.history ?? []), t.created ?? null, t.updated ?? null]);
      imported.tasks++;
    }

    for (const e of events.filter(x => x.project === project)) {
      const { type, project: p, by, taskId, ts, ...rest } = e;
      await client.query(
        `INSERT INTO events (org_id,ts,type,project,by_session,task_id,payload) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [ORG, ts ?? Date.now(), String(type ?? "unknown"), p ?? null, by ?? null,
         Number.isFinite(taskId) ? taskId : null, JSON.stringify(rest ?? {})]);
      imported.events++;
    }

    for (const m of messages.filter(x => x.project === project)) {
      await client.query(
        `INSERT INTO messages (id,org_id,ts,from_session,to_session,project,text,refs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (org_id,id) DO NOTHING`,
        [m.id, ORG, m.ts ?? Date.now(), String(m.from ?? ""), String(m.to ?? "all"), m.project ?? null,
         String(m.text ?? ""), JSON.stringify(m.refs ?? [])]);
      imported.messages++;
    }

    for (const [session, p] of peers.filter(([, x]) => x.project === project)) {
      await client.query(
        `INSERT INTO peers (session,org_id,pubkey,project,status,hook_version,last_seen,online,delivered_up_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (org_id,session) DO NOTHING`,
        [session, ORG, p.pubkey ?? null, p.project ?? null, p.status ?? null, p.hookVersion ?? null,
         p.lastSeen ?? null, p._on === true, p.deliveredUpTo ?? 0]);
      imported.peers++;
    }

    const counts = {
      tasks: tasks.filter(x => x.project === project).length,
      events: events.filter(x => x.project === project).length,
      messages: messages.filter(x => x.project === project).length,
    };
    await client.query(
      `INSERT INTO kv (org_id,key,value) VALUES ($1,$2,$3)
       ON CONFLICT (org_id,key) DO UPDATE SET value=EXCLUDED.value`,
      [ORG, `migrated:${project}`, JSON.stringify({ at: Date.now(), source: SOURCE, counts })]);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`\n✗ ${project}: ROLLED BACK — ${err.message}`);
    await client.end();
    process.exit(1);
  }
}

if (skipped.length) console.log(`skipped  : ${skipped.join(", ")} (already migrated; --force to redo)`);
if (DRY) { console.log("\n[dry run] nothing written."); await client.end(); process.exit(0); }
console.log(`imported : ${imported.tasks} cards · ${imported.events} events · ${imported.messages} messages · ${imported.peers} peers`);

// ---- verified round trip -----------------------------------------------------------------------
console.log("\nverifying round trip:");
let bad = 0;
for (const project of PROJECTS) {
  const srcTasks = tasks.filter(t => t.project === project);
  const r = await client.query("SELECT id,status,title FROM tasks WHERE org_id=$1 AND project=$2", [ORG, project]);
  const ev = await client.query("SELECT count(*)::int c FROM events WHERE org_id=$1 AND project=$2", [ORG, project]);
  const ms = await client.query("SELECT count(*)::int c FROM messages WHERE org_id=$1 AND project=$2", [ORG, project]);
  const srcSum = cardSum(srcTasks), dstSum = cardSum(r.rows);
  const okCards = r.rows.length === srcTasks.length && srcSum === dstSum;
  const okEv = ev.rows[0].c === events.filter(e => e.project === project).length;
  const okMs = ms.rows[0].c === messages.filter(m => m.project === project).length;
  if (!(okCards && okEv && okMs)) bad++;
  console.log(`  ${okCards && okEv && okMs ? "✓" : "✗"} ${project.padEnd(20)} cards ${r.rows.length}/${srcTasks.length} sum ${dstSum === srcSum ? "match" : `MISMATCH ${srcSum}≠${dstSum}`} · events ${ev.rows[0].c} · msgs ${ms.rows[0].c}`);
}
// Tell any RUNNING hub on this database to reload its in-memory projection — without this the
// imported rows stay invisible (and were previously DESTROYED by the hub's next snapshot save).
if (!bad) { try { await client.query("SELECT pg_notify($1, $2)", [CHANGE_CHANNEL, JSON.stringify({ src: "migrate-store" })]); } catch {} }
await client.end();
console.log(bad ? `\n✗ ${bad} project(s) FAILED verification` : "\n✓ all projects verified");
process.exit(bad ? 1 : 0);

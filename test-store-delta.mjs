#!/usr/bin/env node
// test-store-delta.mjs — the boot-cache fix: incremental persist (saveDelta) + LISTEN/NOTIFY.
//
// The property under test: the hub's persist tick must ONLY touch rows the hub has itself seen.
// saveSnapshot's delete-everything-and-rewrite semantics destroyed a second writer's rows every
// second; saveDelta diffs against the last persisted snapshot, so foreign rows survive.
//
// Section 1 (always runs): PgStore.saveDelta against a recording mock pool — asserts exactly which
// statements are issued, and above all that NO blanket deletes exist on the delta path.
// Section 2 (only when RELAY_TEST_PG_URL is set): the real thing against a live Postgres —
// two stores on one database, LISTEN/NOTIFY round-trip, foreign-row survival.
import { PgStore } from "./lib/store-pg.mjs";
import { CHANGE_CHANNEL } from "./lib/store-contract.mjs";

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
};

// --- Section 1: mock-pool unit tests ------------------------------------------------------------
function mockPool() {
  const log = [];
  const client = {
    query: async (sql, vals) => { log.push({ sql: String(sql), vals }); return { rows: [], rowCount: 0 }; },
    release: () => {},
    on: () => client,
    once: () => client,
  };
  return { log, pool: { query: client.query, connect: async () => client } };
}

const baseState = (over = {}) => ({
  messages: [], peers: {}, seq: 0, tasks: [], taskSeq: 0, projectMeta: {}, lessons: [],
  events: [], cardEventsBackfilled: false, aliases: {}, phaseMeta: {}, verifyGates: [],
  verifyGateSeq: 0, balances: { ts: 0, by: "", entries: [] }, subagentCostReset: false,
  handoffLog: [], identities: {}, inviteTokens: {}, focus: {}, orgPolicy: {}, ...over,
});

const task = (id, over = {}) => ({ id, project: "p", title: `t${id}`, status: "todo", assignee: "", source: "", difficulty: "", model: "", phase: "", costUsd: null, deps: [], history: [], ts: 1, updated: 1, ...over });
const event = (id, over = {}) => ({ id, ts: 1, type: "created", project: "p", by: "s", taskId: id, ...over });

console.log("saveDelta: statement selection");
{
  const { log, pool } = mockPool();
  const store = new PgStore({ pool });
  const prev = baseState({ tasks: [task(1), task(2)], events: [event(1)], focus: { a: 1 } });
  const next = baseState({
    tasks: [task(2, { status: "done" }), task(3)],          // 1 removed, 2 changed, 3 added
    events: [event(1), event(2)],                            // 2 appended
    focus: { a: 2 },                                         // kv changed
  });
  const n = await store.saveDelta("local", prev, next, { src: "test-hub" });

  const stmts = log.map(l => l.sql);
  const taskInserts = log.filter(l => l.sql.includes("INSERT INTO tasks"));
  const taskDeletes = log.filter(l => l.sql.includes("DELETE FROM tasks"));
  const eventInserts = log.filter(l => l.sql.includes("INSERT INTO events"));
  const kvInserts = log.filter(l => l.sql.includes("INSERT INTO kv"));
  const notifies = log.filter(l => l.sql.includes("pg_notify"));

  ok(n > 0, "reports changes");
  ok(taskInserts.length === 2 && taskInserts.map(l => l.vals[0]).sort().join(",") === "2,3", "upserts exactly the changed+added tasks (2,3)");
  ok(taskDeletes.length === 1 && JSON.stringify(taskDeletes[0].vals[1]) === "[1]", "deletes exactly the removed task (1) by id list");
  ok(eventInserts.length === 1 && eventInserts[0].vals[0] === 2, "appends only the new event (2)");
  ok(eventInserts.every(l => l.sql.includes("DO NOTHING")), "event insert can never clobber a foreign row (DO NOTHING)");
  ok(kvInserts.length === 1 && kvInserts[0].vals[1] === "focus", "writes only the changed kv key (focus)");
  ok(notifies.length === 1 && notifies[0].vals[0] === CHANGE_CHANNEL && JSON.parse(notifies[0].vals[1]).src === "test-hub", "NOTIFYs the change channel with src");
  ok(!stmts.some(s => /DELETE FROM \w+ WHERE org_id=\$1(?!\s+AND)/.test(s)), "NO blanket per-org delete anywhere");
  ok(!stmts.some(s => s.includes("NOT (id = ANY")), "NO delete-everything-not-in-memory anywhere (foreign rows survive)");
}

console.log("the append-only log actually appends (the 18-day silent death)");
{
  // Production hub, 2026-08-25: the events table had not grown since 7 August. Cause: eventFromRow
  // spread the JSON payload AFTER the column fields, so an event whose payload carried its own `id`
  // came back with the WRONG id. 1198 rows on the live hub carried one. The array tail then reported
  // id 4655 while the table held 9903, appendEvent minted 4656, and every insert from then on hit
  // ON CONFLICT (id) DO NOTHING and was thrown away without a word.
  const { PgStore: PS } = await import("./lib/store-pg.mjs");

  // 1. the read side: a column can never be clobbered by the payload
  const rows = {
    tasks: [], peers: [], messages: [], identities: [], kv: [],
    events: [{ id: 9903, org_id: "local", ts: 5, type: "moved", project: "p", by_session: "s", task_id: 3125,
               payload: { id: 4655, from: "doing", to: "done" } }],
  };
  const client = {
    query: async (sql) => {
      if (/COALESCE\(MAX\(id\),0\)/.test(String(sql))) return { rows: [{ max_id: 9903 }] };
      const t = String(sql).match(/FROM (\w+)/)?.[1] || "";
      return { rows: rows[t] || [], rowCount: 0 };
    },
    release: () => {}, on: () => client, once: () => client,
  };
  const store = new PS({ pool: { query: client.query, connect: async () => client } });
  const snap = await store.loadSnapshot("local");
  const ev = snap.events[0];
  ok(ev.id === 9903, "a payload id can NEVER overwrite the row id");
  ok(ev.from === "doing" && ev.to === "done", "…while the genuine payload fields still come through");
  ok(snap.eventSeq === 9903, "loadSnapshot reports the table's true MAX(id) as the high-water mark");

  // 2. the write side: a column key riding inside the payload is never stored
  const { log, pool } = mockPool();
  const store2 = new PS({ pool });
  const bad = { id: 12, ts: 1, type: "moved", project: "p", by: "s", taskId: 7, payload: { id: 4655, note: "keep" } };
  await store2.saveDelta("local", baseState({ events: [] }), baseState({ events: [bad] }), { src: "t" });
  const ins = log.filter(l => l.sql.includes("INSERT INTO events"))[0];
  const stored = JSON.parse(ins.vals[7]);
  ok(ins.vals[0] === 12, "the row id is the event's own id");
  ok(!("id" in stored), "a shadow id inside the payload is stripped before storage");
  ok(stored.note === "keep", "…without losing the real payload fields");

  // 3. a dropped append is LOUD, never silent
  let dropped = null;
  const noisy = new PS({ pool: { query: async () => ({ rows: [], rowCount: 0 }), connect: async () => ({
    query: async (sql) => ({ rows: [], rowCount: String(sql).includes("INSERT INTO events") ? 0 : 1 }),
    release: () => {}, on() { return this; }, once() { return this; },
  }) } });
  noisy.onDroppedEvent = (d) => { dropped = d; };
  await noisy.saveDelta("local", baseState({ events: [] }), baseState({ events: [{ id: 3, ts: 1, type: "x", project: "p", by: "s" }] }), { src: "t" });
  ok(dropped && dropped.id === 3, "an ON CONFLICT drop reports itself instead of vanishing");
}

console.log("contractReap: the kv key survives the round-trip (the ghost backlog must not rebuild)");
{
  // The reap record says a dispatched contract's assignee went quiet for good. Held only in memory
  // it would rebuild on every hub restart and the whole ghost backlog would re-announce itself, the
  // same shape as the in-memory escalation set. So it has to be a real kv key in BOTH directions,
  // and the file store proving it is not enough: production is Postgres.
  const { log, pool } = mockPool();
  const store = new PgStore({ pool });
  const reap = { "42": { ts: 7, from: "host:p", to: "codex:p", reason: "assignee codex:p never seen on the bus, past the 60m abandon window", dispatchedTs: 5 } };
  await store.saveDelta("local", baseState({ contractReap: {} }), baseState({ contractReap: reap }), { src: "test-hub" });
  const kvInserts = log.filter(l => l.sql.includes("INSERT INTO kv"));
  ok(kvInserts.length === 1 && kvInserts[0].vals[1] === "contractReap", "saveDelta writes contractReap when it changes");
  ok(JSON.parse(kvInserts[0].vals[2] || "{}")["42"]?.to === "codex:p", "…carrying the record itself, not an empty object");

  // and an UNCHANGED reap map must not be rewritten every persist tick
  const { log: log2, pool: pool2 } = mockPool();
  const store2 = new PgStore({ pool: pool2 });
  await store2.saveDelta("local", baseState({ contractReap: reap, focus: { a: 1 } }), baseState({ contractReap: reap, focus: { a: 2 } }), { src: "test-hub" });
  const kv2 = log2.filter(l => l.sql.includes("INSERT INTO kv"));
  ok(kv2.length === 1 && kv2[0].vals[1] === "focus", "…and is NOT rewritten when it has not changed");
}

{
  // the read half: a kv row must come back as state.contractReap, or the restart forgets everything
  const rows = {
    tasks: [], peers: [], events: [], messages: [], identities: [],
    kv: [{ key: "contractReap", value: { "42": { ts: 7, to: "codex:p", reason: "gone" } } }],
  };
  const client = {
    query: async (sql) => {
      const t = String(sql).match(/FROM (\w+)/)?.[1] || "";
      return { rows: rows[t] || [], rowCount: 0 };
    },
    release: () => {}, on: () => client, once: () => client,
  };
  const store = new PgStore({ pool: { query: client.query, connect: async () => client } });
  const snap = await store.loadSnapshot("local");
  ok(snap.contractReap && snap.contractReap["42"]?.to === "codex:p", "loadSnapshot rehydrates contractReap from kv");
}

console.log("task extra fields: pack + unpack (the cost-metadata fidelity fix)");
{
  const { PgStore: PS } = await import("./lib/store-pg.mjs");
  const { taskExtra } = await import("./lib/store-pg.mjs");
  // pack: non-column fields → extra; column fields stay out of it
  const t = task(7, { costKind: "subagent-notional", tokens: { input: 5, output: 9 }, count: 3, _aid: "a1" });
  const extra = taskExtra(t);
  ok(extra.costKind === "subagent-notional" && extra.count === 3 && extra._aid === "a1" && extra.tokens?.output === 9,
     "costKind/tokens/count/_aid land in extra");
  ok(!("title" in extra) && !("status" in extra) && !("costUsd" in extra), "column fields stay OUT of extra");
  // write path: the INSERT actually carries the extra parameter
  const { log, pool } = mockPool();
  const store = new PS({ pool });
  await store.saveDelta("local", baseState(), baseState({ tasks: [t] }), { src: "t" });
  const ins = log.find(l => l.sql.includes("INSERT INTO tasks"));
  ok(!!ins && ins.sql.includes("extra") && JSON.parse(ins.vals[15]).costKind === "subagent-notional",
     "task INSERT persists extra as the 16th column");
}

console.log("saveDelta: no-op short-circuit");
{
  const { log, pool } = mockPool();
  const store = new PgStore({ pool });
  const prev = baseState({ tasks: [task(1)], events: [event(1)] });
  const next = JSON.parse(JSON.stringify(prev));
  const n = await store.saveDelta("local", prev, next, { src: "test-hub" });
  ok(n === 0, "identical snapshots report 0 changes");
  ok(log.length === 0, "identical snapshots issue no statements (and no NOTIFY)");
}

console.log("saveDelta: foreign-row immunity by construction");
{
  const { log, pool } = mockPool();
  const store = new PgStore({ pool });
  // A foreign writer added task 999 + event 999 to the DB. The hub has never seen them: they are
  // in NEITHER snapshot. Nothing the delta writes may reference id 999.
  const prev = baseState({ tasks: [task(1)] });
  const next = baseState({ tasks: [task(1, { status: "doing" })] });
  await store.saveDelta("local", prev, next, { src: "test-hub" });
  const touches999 = log.some(l => (l.vals || []).some(v => v === 999 || (Array.isArray(v) && v.includes(999))));
  ok(!touches999, "a row the hub never saw is never referenced");
  ok(log.filter(l => l.sql.includes("DELETE")).length === 0, "an update-only tick issues no deletes at all");
}

console.log("saveDelta: peers + messages diff by natural key");
{
  const { log, pool } = mockPool();
  const store = new PgStore({ pool });
  const prev = baseState({
    peers: { a: { lastSeen: 1, status: "", project: "p" }, b: { lastSeen: 1, status: "", project: "p" } },
    messages: [{ id: 1, ts: 1, from: "a", to: "b", project: "p", text: "hi", refs: [] }],
  });
  const next = baseState({
    peers: { a: { lastSeen: 2, status: "", project: "p" } },                    // b dropped, a touched
    messages: [{ id: 1, ts: 1, from: "a", to: "b", project: "p", text: "hi", refs: [] },
               { id: 2, ts: 2, from: "b", to: "a", project: "p", text: "yo", refs: [] }],
  });
  await store.saveDelta("local", prev, next, { src: "test-hub" });
  const peerUpserts = log.filter(l => l.sql.includes("INSERT INTO peers"));
  const peerDeletes = log.filter(l => l.sql.includes("DELETE FROM peers"));
  const msgInserts = log.filter(l => l.sql.includes("INSERT INTO messages"));
  ok(peerUpserts.length === 1 && peerUpserts[0].vals[0] === "a", "upserts only the touched peer");
  ok(peerDeletes.length === 1 && JSON.stringify(peerDeletes[0].vals[1]) === '["b"]', "deletes only the dropped peer by session list");
  ok(msgInserts.length === 1 && msgInserts[0].vals[0] === 2, "appends only the new message");
}

// --- Section 2: live Postgres integration (opt-in) ----------------------------------------------
const PG_URL = process.env.RELAY_TEST_PG_URL || "";
if (!PG_URL) {
  console.log("\n(live Postgres section skipped — set RELAY_TEST_PG_URL to run it)");
} else {
  console.log("\nlive Postgres: delta round-trip + LISTEN/NOTIFY + foreign-row survival");
  const A = new PgStore({ url: PG_URL });    // "the hub"
  const B = new PgStore({ url: PG_URL });    // "the second writer"
  await A.init(); await B.init();
  const orgId = `t${Date.now() % 1e9}`;      // fresh org per run — keeps reruns independent
  await A.createOrg({ id: orgId, name: orgId, ownerPubkey: "test" });

  // LISTEN as the hub would
  const notes = [];
  await A.subscribeChanges(p => notes.push(p));

  // hub persists a delta
  const s0 = baseState();
  const s1 = baseState({ tasks: [task(1)], events: [event(1)] });
  await A.saveDelta(orgId, s0, s1, { src: "hub-A" });

  // second writer adds a foreign task directly
  await B.upsertTask(orgId, task(999, { title: "foreign", status: "todo" }));
  await B.notifyChanges("writer-B");

  // hub persists ANOTHER delta (this used to destroy task 999)
  const s2 = baseState({ tasks: [task(1, { status: "done" })], events: [event(1)] });
  await A.saveDelta(orgId, s1, s2, { src: "hub-A" });

  const snap = await A.loadSnapshot(orgId);
  ok(snap.tasks.some(t => t.id === 999 && t.title === "foreign"), "foreign row SURVIVES the hub's persist tick");
  ok(snap.tasks.some(t => t.id === 1 && t.status === "done"), "hub's own delta landed");

  await new Promise(r => setTimeout(r, 300));   // NOTIFY delivery
  ok(notes.some(p => p.src === "writer-B"), "hub RECEIVES the second writer's NOTIFY");
  ok(notes.some(p => p.src === "hub-A"), "hub's own saveDelta also NOTIFYs (for other hub instances)");

  await A.close(); await B.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

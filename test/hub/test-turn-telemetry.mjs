#!/usr/bin/env node
import "../isolate-bus.mjs";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadOrCreate } from "../../lib/identity.mjs";
import { sfetchJson } from "../../lib/signed-fetch.mjs";
import { PgStore } from "../../lib/store-pg.mjs";
import { createStoreRuntime } from "../../hub/store.mjs";
import { routeInsights } from "../../hub/routes/insights.mjs";
import { startTestHub } from "../lib/test-hub.mjs";

let passed = 0;
const ok = (condition, name) => {
  assert.ok(condition, name);
  passed++;
  console.log(`  ✓ ${name}`);
};
const dir = mkdtempSync(join(resolve(".agent-bus-out"), "turn-telemetry-"));
const project = "telemetry";
const now = Date.now();
const day = new Date(now).toISOString().slice(0, 10);
const owner = loadOrCreate("telemetry-owner", "human");
const seatA = loadOrCreate(`seat-a:${project}`, "agent");
const seatB = loadOrCreate(`seat-b:${project}`, "agent");
let sequence = 0;
function row(overrides = {}) {
  sequence++;
  return {
    id: sequence.toString(16).padStart(32, "0"), v: 1, ts: now, persona: "seat-a", agent: "kimi", project,
    machine: "netcup", turn: sequence, trigger: "contract", card: 14066, model: "kimi", duration_ms: 1250,
    tokens: 42, usage: { input: 40, output: 2 }, exit: 0, effExit: 0, outcome: "completed", verdict: "done",
    ...overrides,
  };
}
async function request(base, identity, path, payload) {
  const response = await sfetchJson(`${base}${path}`, { identity, payload });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
const post = (base, identity, rows) => request(base, identity, "/telemetry/turns", { rows });
let hub;

try {
  hub = await startTestHub({ dir, env: { RELAY_AUTH: "enforce", RELAY_ENROLL: "tofu" } });
  ok((await request(hub.base, owner, "/enroll", { name: owner.name, kind: "human", scopes: [{ project: "*", role: "owner" }] })).status === 200, "owner enrolls");
  for (const seat of [seatA, seatB]) {
    ok((await request(hub.base, seat, "/enroll", { name: seat.name, kind: "agent", scopes: [{ project, role: "write" }] })).status === 200, `${seat.name} enrolls`);
  }
  let health = await (await fetch(`${hub.base}/health`)).json();
  assert.deepEqual(health.telemetry, { lastRowTs: null, rows24h: 0 });
  passed++;
  console.log("  ✓ empty health exposes telemetry counters");

  const first = row();
  const failed = row({ outcome: "empty", verdict: "exit zero but no delivery" });
  let result = await post(hub.base, seatA, [first, failed]);
  assert.deepEqual(result.body, { ok: true, stored: 2, duplicates: 0, dropped: 0 });
  ok(result.status === 200, "signed seat batch stores turn rows");
  result = await post(hub.base, seatA, [first, failed]);
  assert.deepEqual(result.body, { ok: true, stored: 0, duplicates: 2, dropped: 0 });
  ok(result.status === 200, "retry counts every row as a duplicate");

  result = await post(hub.base, seatA, [row({ persona: "seat-b" })]);
  ok(result.status === 403, "a seat cannot report another seat's row");
  const valid = row();
  const invalid = [
    row({ ts: now + 61000 }),
    row({ turn: 0 }),
    row({ id: "not-a-turn-id" }),
    row({ outcome: "unknown" }),
    row({ text: "output must not be accepted" }),
  ];
  result = await post(hub.base, seatA, [valid, ...invalid]);
  assert.deepEqual(result.body, { ok: true, stored: 1, duplicates: 0, dropped: invalid.length });
  ok(result.status === 200, "invalid rows drop without failing the valid batch row");
  result = await post(hub.base, seatB, [row({ persona: "seat-b", agent: "codex", model: "gpt", ts: now + 1000 })]);
  ok(result.status === 200 && result.body.stored === 1, "a second seat reports its own row");
  const history = row({ persona: "seat-b", agent: "codex", model: "gpt", turn: 99 });
  result = await post(hub.base, owner, [history]);
  ok(result.status === 200 && result.body.stored === 1, "owner can backfill another seat's history");
  result = await post(hub.base, seatA, Array.from({ length: 101 }, () => row()));
  ok(result.status === 400, "batches over 100 rows are refused");

  health = await (await fetch(`${hub.base}/health`)).json();
  ok(health.telemetry.rows24h === 5 && health.telemetry.lastRowTs === now + 1000, "health counts stored rows only and tracks the newest timestamp");
  const old = row({ ts: now - 181 * 86400000, turn: 100 });
  result = await post(hub.base, seatA, [old]);
  ok(result.status === 200 && result.body.stored === 1, "old history can be backfilled before retention runs");
  appendFileSync(join(dir, "turns.jsonl"), `${JSON.stringify(first)}\n`);
  await hub.stop();
  hub = null;

  hub = await startTestHub({ dir });
  health = await (await fetch(`${hub.base}/health`)).json();
  ok(health.telemetry.rows24h === 5, "restart rebuilds the 24-hour health count");
  const compacted = readFileSync(join(dir, "turns.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  ok(compacted.length === 5 && new Set(compacted.map(item => item.id)).size === 5, "boot compacts duplicate file rows");
  ok(!compacted.some(item => item.id === old.id), "boot prunes rows older than 180 days");
  await hub.stop();
  hub = null;

  const runtime = await createStoreRuntime({ STORE_KIND: "json", DATA: join(dir, "bus.json") });
  const totals = runtime.turnTelemetry.readTotals();
  const kimi = totals.find(total => total.day === day && total.project === project && total.agent === "kimi");
  ok(kimi?.turns === 3 && kimi.failed === 1 && kimi.outcomes.empty === 1, "daily project/agent totals rebuild from the compacted store");
  ok(kimi.lastFailure?.outcome === "empty" && kimi.lastFailure?.exit === 0, "failure totals use outcome rather than raw exit code");
  const codex = totals.find(total => total.day === day && total.project === project && total.agent === "codex");
  ok(codex?.turns === 2 && codex.models.includes("gpt"), "models and owner-backfilled rows survive restart totals");
} finally {
  if (hub) await hub.stop();
  rmSync(dir, { recursive: true, force: true });
}

{
  const calls = [];
  const sample = row();
  const pool = {
    query: async (sql, values = []) => {
      const text = String(sql);
      calls.push({ sql: text, values });
      if (text.includes("INSERT INTO turns(")) return { rows: [{ id: values[1] }], rowCount: 1 };
      if (text.includes("SELECT row FROM turns")) return { rows: [{ row: JSON.stringify(sample) }], rowCount: 1 };
      if (text.includes("DELETE FROM turns")) return { rows: [], rowCount: 7 };
      return { rows: [], rowCount: 0 };
    },
  };
  const store = new PgStore({ pool });
  await store.init();
  ok(calls.some(call => call.sql.includes("CREATE TABLE IF NOT EXISTS turns")), "Postgres init creates the separate turns table");
  const appended = await store.appendTurns("local", [sample, sample, row()]);
  const insert = calls.find(call => call.sql.includes("INSERT INTO turns("));
  ok(insert.sql.includes("ON CONFLICT(org_id, id) DO NOTHING") && appended.storedRows.length === 1 && appended.duplicates === 2, "Postgres insert deduplicates conflicts and same-batch ids");
  ok(JSON.parse(insert.values[12]).outcome === sample.outcome, "Postgres stores the complete row JSON beside projected columns");
  const loaded = await store.loadTurns("local", 0);
  ok(loaded.length === 1 && loaded[0].id === sample.id, "Postgres load rehydrates whole turn rows");
  ok(await store.pruneTurns("local", now) === 7, "Postgres retention deletes by turn timestamp");
}

{
  const sample = row();
  let response;
  let logCount = 0;
  const originalWrite = process.stderr.write;
  process.stderr.write = () => { logCount++; return true; };
  try {
    await routeInsights({
      req: { method: "POST" }, res: {}, q: {}, P: "/telemetry/turns",
      auth: { identity: { name: "seat-a:telemetry" } },
      ctx: {
        AUTH_MODE: "enforce", body: async () => ({ rows: [sample] }), now: () => now,
        scopeAllows: () => false,
        turnTelemetry: { append: async () => { throw new Error("disk unavailable"); } },
        json: (_res, code, body) => { response = { code, body }; return true; },
      },
    });
  } finally {
    process.stderr.write = originalWrite;
  }
  ok(response?.code === 500 && response.body.error.includes("disk unavailable") && logCount === 1, "store failure returns its reason and logs exactly once");
}

console.log(`${passed} turn telemetry checks passed`);

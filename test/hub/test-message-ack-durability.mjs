#!/usr/bin/env node
// trantor — a `wake:false` ack must STILL be an ack after the hub restarts on Postgres (#7140).
//
// #7079 taught /contracts that a `wake:false` send, a `receipt` or a `status` owes nothing back,
// so the stop gate stops blocking the dispatcher over them. It held in memory and died at the
// store: the messages table had no `wake` and no `kind` column, so the pg store dropped both on
// write and could not return them on read. Every hub restart reloaded each outstanding ack as a
// plain contract, which aged into `stalled` and blocked the orchestrator again — the exact failure
// the merge was gated against, reintroduced one layer down. The gate had run on a json-store test
// hub and never restarted a pg one, which is why this file forces a real round trip.
//
// Three sections: the static shape of the fix (every write path, the read path), a round trip
// through the real encoder/decoder against a recording pool, and — when a Postgres is reachable —
// the thing that actually broke: a hub on RELAY_STORE=pg, a `wake:false` send, a restart, and
// /contracts still calling it `ack`.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PgStore } from "../../lib/store-pg.mjs";
import { SCHEMA_SQL } from "../../lib/store-contract.mjs";
import { drillEnv } from "../drill-env.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log("# trantor message-ack durability (#7140)");

// --- Section 1: the shape of the fix ------------------------------------------------------------
const src = readFileSync(join(ROOT, "lib", "store-pg.mjs"), "utf8");

console.log("\nThe columns exist, on new hubs and on ones that predate them:");
const createTable = (SCHEMA_SQL.match(/CREATE TABLE IF NOT EXISTS messages \([\s\S]*?PRIMARY KEY/i) || [""])[0];
ok("the messages table declares wake", /\bwake\s+BOOLEAN/i.test(createTable), "not in CREATE TABLE");
ok("…and kind", /\bkind\s+TEXT/i.test(createTable), "not in CREATE TABLE");
ok("an additive ALTER carries existing databases forward for wake",
  /ALTER TABLE messages ADD COLUMN IF NOT EXISTS wake BOOLEAN/i.test(SCHEMA_SQL), "no ALTER for wake");
ok("…and for kind", /ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind TEXT/i.test(SCHEMA_SQL), "no ALTER for kind");

console.log("\nEvery write path carries them (a partial fix is how `re` broke the first time):");
const inserts = src.match(/INSERT INTO messages\([^)]*\)/g) || [];
ok("there is more than one insert path", inserts.length >= 2, `${inserts.length} found`);
ok("every INSERT INTO messages lists wake and kind",
  inserts.length > 0 && inserts.every(i => /\bwake\b/.test(i) && /\bkind\b/.test(i)),
  inserts.filter(i => !/\bwake\b/.test(i) || !/\bkind\b/.test(i)).join(" | ").slice(0, 200));
const upserts = src.match(/INSERT INTO messages[\s\S]{0,500}?DO UPDATE SET[^`]*/g) || [];
ok("the upsert paths update wake and kind too",
  upserts.length > 0 && upserts.every(u => /wake=EXCLUDED\.wake/.test(u) && /kind=EXCLUDED\.kind/.test(u)),
  upserts.filter(u => !/wake=EXCLUDED\.wake/.test(u) || !/kind=EXCLUDED\.kind/.test(u)).join(" | ").slice(0, 200));

console.log("\nAnd the read path returns them the way the hub mints them:");
const decoder = (src.match(/function msgFromRow[\s\S]*?\n}/) || [""])[0];
ok("msgFromRow maps wake back onto the message", /\bwake\b/.test(decoder), "msgFromRow drops it");
ok("…and kind", /\bkind\b/.test(decoder), "msgFromRow drops it");
ok("a NULL wake reads as ABSENT, never false — an old row stays a contract",
  /if \(row\.wake === false\) m\.wake = false;/.test(decoder) && !/wake: (row\.wake|false|!!)/.test(decoder), decoder.slice(0, 300));

// --- Section 2: round trip through the real encoder/decoder --------------------------------------
// A recording pool that keeps what the store INSERTs, by column name, and hands it back to the
// store's own SELECT. Nothing here re-implements the store; it only replaces the wire.
function recordingPool() {
  const rows = [];
  const columnsOf = (sql) => (sql.match(/INSERT INTO messages\(([^)]*)\)/) || ["", ""])[1].split(",").map(s => s.trim()).filter(Boolean);
  const query = async (sql, vals = []) => {
    sql = String(sql);
    if (/INSERT INTO messages/.test(sql)) {
      const cols = columnsOf(sql);
      // appendMessage computes `id` in SQL and binds the rest; the snapshot/delta paths bind all.
      const bound = vals.length === cols.length ? vals : [rows.length + 1, ...vals];
      const row = Object.fromEntries(cols.map((c, i) => [c, bound[i]]));
      row.refs = JSON.parse(row.refs || "[]");
      rows.push(row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }
    if (/^\s*SELECT \* FROM messages/.test(sql)) return { rows: rows.slice(), rowCount: rows.length };
    if (/max_id/.test(sql)) return { rows: [{ max_id: 0 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release: () => {}, on: () => client, once: () => client };
  return { rows, pool: { query, connect: async () => client } };
}
const baseState = (overrides = {}) => ({
  messages: [], peers: {}, seq: 0, tasks: [], taskSeq: 0, projectMeta: {}, lessons: [],
  events: [], cardEventsBackfilled: false, aliases: {}, phaseMeta: {}, verifyGates: [],
  verifyGateSeq: 0, proposals: [], proposalSeq: 0, balances: { ts: 0, by: "", entries: [] },
  subagentCostReset: false, handoffLog: [], identities: {}, inviteTokens: {}, instances: {},
  focus: {}, orgPolicy: {}, contractReap: {}, eventSeq: 0, ...overrides,
});
const msg = (id, extra = {}) => ({ id, ts: 1_700_000_000_000 + id, from: "acker:life", to: "qwen:life", project: "life", text: `m${id}`, refs: [], ...extra });

console.log("\nWhat goes in comes back out, on both write paths:");
{
  const { pool } = recordingPool();
  const store = new PgStore({ pool });
  await store.appendMessage("local", msg(1, { wake: false }));
  await store.appendMessage("local", msg(2, { kind: "receipt" }));
  await store.appendMessage("local", msg(3));
  // The live hub persists through saveDelta, not appendMessage — both must carry the flag.
  await store.saveDelta("local", baseState(), baseState({ messages: [msg(4, { wake: false }), msg(5, { kind: "status" }), msg(6)] }), { src: "t" });
  const snap = await store.loadSnapshot("local");
  const byId = new Map((snap.messages || []).map(m => [Number(m.id), m]));
  ok("six messages round-tripped", byId.size === 6, `${byId.size}`);
  ok("wake:false survives appendMessage", byId.get(1)?.wake === false, JSON.stringify(byId.get(1)));
  ok("wake:false survives saveDelta", byId.get(4)?.wake === false, JSON.stringify(byId.get(4)));
  ok("kind survives appendMessage", byId.get(2)?.kind === "receipt", JSON.stringify(byId.get(2)));
  ok("kind survives saveDelta", byId.get(5)?.kind === "status", JSON.stringify(byId.get(5)));
  ok("a plain contract comes back with NO wake key and NO kind key — exactly as the hub minted it",
    [3, 6].every(id => byId.has(id) && !("wake" in byId.get(id)) && !("kind" in byId.get(id))),
    JSON.stringify([byId.get(3), byId.get(6)]));
}

// --- Section 3: the real thing — a pg-backed hub, a restart, /contracts ---------------------------
// Runs against RELAY_TEST_PG_URL when set; otherwise spins a throwaway cluster with the initdb and
// pg_ctl on PATH (socket-only, in a temp dir, torn down after). Skips loudly when neither exists.
const haveBin = (b) => spawnSync("sh", ["-c", `command -v ${b}`], { stdio: "ignore" }).status === 0;
let PG_URL = process.env.RELAY_TEST_PG_URL || "";
let cluster = null;
if (!PG_URL && haveBin("initdb") && haveBin("pg_ctl")) {
  cluster = mkdtempSync(join(tmpdir(), "trantor-ackpg-"));
  const data = join(cluster, "data");
  const init = spawnSync("initdb", ["-D", data, "-U", "trantor", "-A", "trust", "--no-locale", "-E", "UTF8"], { encoding: "utf8" });
  const port = 54327;
  const start = init.status === 0
    ? spawnSync("pg_ctl", ["-D", data, "-o", `-p ${port} -k ${cluster} -c listen_addresses=''`, "-l", join(cluster, "pg.log"), "-w", "start"], { encoding: "utf8" })
    : null;
  if (start?.status === 0) PG_URL = `postgres://trantor@/postgres?host=${cluster}&port=${port}`;
  else { console.log(`  ✗ could not start a throwaway Postgres — ${(init.stderr || start?.stderr || "").trim().slice(0, 200)}`); fail++; }
}

if (!PG_URL) {
  console.log("\n(live Postgres section skipped — set RELAY_TEST_PG_URL or put initdb/pg_ctl on PATH to run it)");
} else {
  console.log("\nA pg-backed hub restarts and a wake:false send is STILL an ack:");
  const PORT = 47953;
  const BASE = `http://127.0.0.1:${PORT}`;
  const dir = mkdtempSync(join(tmpdir(), "trantor-ackhub-"));
  mkdirSync(join(dir, ".agent-bus"), { recursive: true });
  const ORG = `t${Date.now() % 1e9}`;       // fresh org per run — reruns against a shared DB stay independent
  const env = {
    ...drillEnv(), RELAY_DATA_DIR: dir, HOME: dir, RELAY_PORT: String(PORT), PORT: String(PORT),
    TRANTOR_NO_UPDATE_CHECK: "1", RELAY_STORE: "pg", RELAY_DATABASE_URL: PG_URL, RELAY_ORG_ID: ORG,
  };
  const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json()).catch(e => ({ error: String(e) }));
  const get = (p) => fetch(BASE + p).then(r => r.json()).catch(e => ({ error: String(e) }));
  const AO = "acker:life", AS = "qwen:life", PROJ = "life";

  let hub = null, stderr = "";
  const boot = async () => {
    stderr = "";
    hub = spawn("node", [join(ROOT, "hub.mjs")], { env, stdio: ["ignore", "ignore", "pipe"] });
    hub.stderr.on("data", d => { stderr += d; });
    const exited = new Promise(r => hub.once("exit", code => r(code)));
    for (let i = 0; i < 60; i++) {
      const up = await Promise.race([get("/health"), exited]);
      if (up && !up.error && Number.isNaN(Number(up))) return true;
      if (hub.exitCode != null) return false;
      await sleep(250);
    }
    return false;
  };
  const stop = async () => {
    if (!hub || hub.exitCode != null) return;
    const exited = new Promise(r => hub.once("exit", r));
    hub.kill("SIGTERM");
    await Promise.race([exited, sleep(4000)]);
    if (hub.exitCode == null) { hub.kill("SIGKILL"); await exited; }
  };

  try {
    ok("the hub boots on RELAY_STORE=pg", await boot(), stderr.slice(0, 300));
    await post("/register", { session: AO, project: PROJ, status: "orchestrating" });
    await post("/register", { session: AS, project: PROJ, status: "working" });
    const a1 = await post("/send", { from: AO, to: AS, project: PROJ, text: "read and acked, nothing here needs you", wake: false });
    const a2 = await post("/send", { from: AO, to: AS, project: PROJ, text: "✅ #6897 accepted and DONE", kind: "receipt" });
    const c1 = await post("/send", { from: AO, to: AS, project: PROJ, text: "land the derm formulary" });
    ok("three sends landed", [a1, a2, c1].every(r => Number(r.id) > 0), JSON.stringify([a1, a2, c1]).slice(0, 200));
    {
      const r = await get(`/contracts?session=${encodeURIComponent(AO)}&overdueMs=0`);
      ok("before the restart: two acks, one real contract", r.ack === 2 && (r.contracts || []).length === 1,
        JSON.stringify({ ack: r.ack, contracts: r.contracts?.length }));
    }

    // Let the persist tick (1s) write the rows, then prove the FLAG is on disk before trusting the
    // restart: this isolates a write-side loss from a read-side one.
    await sleep(2500);
    const probe = new PgStore({ url: PG_URL });
    await probe.init();
    const onDisk = await probe.loadSnapshot(ORG);
    const rowOf = (id) => (onDisk.messages || []).find(m => Number(m.id) === Number(id));
    ok("the wake:false row on disk carries wake=false", rowOf(a1.id)?.wake === false, JSON.stringify(rowOf(a1.id)));
    ok("the receipt row on disk carries its kind", rowOf(a2.id)?.kind === "receipt", JSON.stringify(rowOf(a2.id)));
    ok("the real contract's row carries neither", !!rowOf(c1.id) && !("wake" in rowOf(c1.id)) && !("kind" in rowOf(c1.id)), JSON.stringify(rowOf(c1.id)));

    await stop();
    ok("the hub comes back from Postgres", await boot(), stderr.slice(0, 300));
    {
      const r = await get(`/contracts?session=${encodeURIComponent(AO)}&overdueMs=0`);
      const acks = new Map((r.ackContracts || []).map(c => [Number(c.id), c]));
      ok("after the restart the wake:false send is STILL an ack — not stalled, not waiting",
        acks.get(Number(a1.id))?.disposition === "ack", JSON.stringify(r).slice(0, 300));
      ok("…and so is the receipt", acks.get(Number(a2.id))?.disposition === "ack", JSON.stringify(acks.get(Number(a2.id))));
      ok("the reloaded ack rows say WHY they are acks (wake / kind ride on the contract row)",
        acks.get(Number(a1.id))?.wake === false && acks.get(Number(a2.id))?.kind === "receipt",
        JSON.stringify([acks.get(Number(a1.id)), acks.get(Number(a2.id))]));
      ok("the real contract is the ONLY row in `contracts`, and it is still owed",
        (r.contracts || []).length === 1 && Number(r.contracts[0].id) === Number(c1.id) && r.contracts[0].disposition !== "ack",
        JSON.stringify(r.contracts));
      ok("so the stop gate has exactly one thing to block on, not three", r.ack === 2 && (r.open ?? 0) + (r.waiting ?? 0) + (r.stalled ?? 0) >= 1 && r.stalled + r.waiting === 1,
        JSON.stringify({ ack: r.ack, open: r.open, waiting: r.waiting, stalled: r.stalled }));
    }

    // A row written BEFORE the columns existed has NULL in both. Simulate exactly that database:
    // drop the columns, let init() add them back empty, restart. The old ack must come back as a
    // plain contract — never silently as an ack, which is what a `false` default would have done.
    await stop();
    await probe.pool.query("ALTER TABLE messages DROP COLUMN wake, DROP COLUMN kind");
    await probe.init();
    const cols = await probe.pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='messages' AND column_name IN ('wake','kind')");
    ok("init() re-adds the columns to a database that predates them", cols.rows.length === 2, JSON.stringify(cols.rows));
    const after = await probe.loadSnapshot(ORG);
    const oldRow = (id) => (after.messages || []).find(m => Number(m.id) === Number(id));
    ok("…and the old rows read back with NO wake and NO kind, not wake=false",
      !!oldRow(a1.id) && !("wake" in oldRow(a1.id)) && !!oldRow(a2.id) && !("kind" in oldRow(a2.id)),
      JSON.stringify([oldRow(a1.id), oldRow(a2.id)]).slice(0, 200));
    await probe.close?.();
    ok("the hub boots on the migrated database", await boot(), stderr.slice(0, 300));
    {
      const r = await get(`/contracts?session=${encodeURIComponent(AO)}&overdueMs=0`);
      const ids = new Set((r.contracts || []).map(c => Number(c.id)));
      ok("a pre-migration row (NULL wake, NULL kind) is a normal contract, not an ack",
        r.ack === 0 && ids.has(Number(a1.id)) && ids.has(Number(a2.id)) && ids.has(Number(c1.id)),
        JSON.stringify({ ack: r.ack, contracts: [...ids] }));
    }
  } finally {
    await stop();
    if (cluster) {
      spawnSync("pg_ctl", ["-D", join(cluster, "data"), "-w", "-m", "fast", "stop"], { stdio: "ignore" });
      rmSync(cluster, { recursive: true, force: true });
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${fail === 0 ? "✅" : "❌"} message-ack-durability: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

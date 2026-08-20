#!/usr/bin/env node
// Card-log contract test: notes live on the card, survive restart, cap at 40, and stale todo cards
// record their reaper story on the card itself.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DAY = 24 * 60 * 60 * 1000;
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function spawnHub(port, dir) {
  const hub = spawn("node", [join(ROOT, "hub.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: dir,
      RELAY_DATA_DIR: dir,
      RELAY_PORT: String(port),
      PORT: String(port),
      RELAY_REAP_INTERVAL_MS: "120",
      RELAY_TODO_STALE_MS: "250",
      RELAY_ONLINE_MS: "999999",
      TRANTOR_NO_UPDATE_CHECK: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  hub._stderr = "";
  hub.stderr.on("data", d => { hub._stderr += String(d); });
  return hub;
}

async function waitHub(base, hub) {
  for (let i = 0; i < 50; i++) {
    if (hub.exitCode !== null) throw new Error(`hub exited early: ${hub._stderr}`);
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`hub did not become healthy: ${hub._stderr}`);
}

async function stopHub(hub) {
  hub.kill();
  await Promise.race([
    new Promise(r => hub.once("close", r)),
    sleep(1500).then(() => hub.kill("SIGKILL")),
  ]);
}

function client(base) {
  return {
    post: (p, b) => fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(b),
    }).then(r => r.json()),
    get: (p) => fetch(base + p).then(r => r.json()),
  };
}

console.log("# card log contract");

const dir = mkdtempSync(join(tmpdir(), "trantor-cardlog-"));
const port = 47874;
const base = `http://127.0.0.1:${port}`;
mkdirSync(dir, { recursive: true });

const legacyTs = Date.now() - (20 * DAY);
writeFileSync(join(dir, "bus.json"), JSON.stringify({
  tasks: [{
    id: 1,
    project: "cardlog",
    title: "legacy todo",
    assignee: "codex:cardlog",
    status: "todo",
    by: "legacy",
    ts: 0,
    updated: legacyTs,
    history: [{ to: "todo", by: "legacy", ts: legacyTs - 1000 }],
  }],
  taskSeq: 1,
  events: [],
}));

let hub = spawnHub(port, dir);
try {
  await waitHub(base, hub);
  const A = client(base);

  await sleep(550);
  const legacy = (await A.get("/tasks?project=cardlog")).tasks.find(t => t.id === 1);
  ok("boot backfills ts:0 from history", legacy?.ts === legacyTs - 1000, `got ${legacy?.ts}`);
  ok("todo-stale reaper moves old todo to stale", legacy?.status === "stale", `got ${legacy?.status}`);
  ok("todo-stale reaper writes a card log note",
    legacy?.log?.some(e => e.by === "reaper" && /todo aged out after 20d untouched/.test(e.text)),
    JSON.stringify(legacy?.log));

  const created = await A.post("/task", {
    project: "cardlog",
    title: "durable story",
    status: "doing",
    by: "codex:cardlog",
    note: "seed note",
  });
  const id = created?.task?.id;
  ok("/task note seeds log[0]", created?.task?.log?.[0]?.text === "seed note", JSON.stringify(created?.task?.log));

  const noteOnly = await A.post("/task/update", { id, by: "codex:cardlog", note: "note-only update" });
  ok("note-only /task/update is legal", noteOnly?.ok === true && noteOnly?.task?.status === "doing");
  ok("note-only /task/update appends log", noteOnly?.task?.log?.at(-1)?.text === "note-only update", JSON.stringify(noteOnly?.task?.log));

  for (let i = 0; i < 45; i++) await A.post("/task/update", { id, by: "codex:cardlog", note: `bulk ${i}` });
  const capped = (await A.get(`/card?id=${id}`)).task;
  ok("card log caps at 40 entries", capped?.log?.length === 40, `got ${capped?.log?.length}`);
  ok("card log drops oldest entries first", capped?.log?.[0]?.text === "bulk 5", `first=${capped?.log?.[0]?.text}`);
  ok("card log keeps newest entry", capped?.log?.at(-1)?.text === "bulk 44", `last=${capped?.log?.at(-1)?.text}`);

  await sleep(1400);
  await stopHub(hub);

  hub = spawnHub(port, dir);
  await waitHub(base, hub);
  const B = client(base);
  const roundTrip = (await B.get(`/card?id=${id}`)).task;
  ok("restart round-trip preserves card log", roundTrip?.log?.length === 40 && roundTrip.log.at(-1)?.text === "bulk 44", JSON.stringify(roundTrip?.log));
} catch (e) {
  fail++;
  console.log(`  FAIL  test threw\n        ${e?.stack || e}`);
} finally {
  if (hub?.exitCode === null) await stopHub(hub);
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);

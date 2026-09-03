#!/usr/bin/env node
// trantor adopt/import + peer identity tests (2026-07-30).
//
// /import is the migration surface behind `trantor adopt`: the CLI reads a project off the local
// hub and POSTs it to the target — no ssh, no direct Postgres. Kept honest here:
//   1. rows land under the project, colliding card ids get FRESH ids and their events re-point
//   2. a second import without force is refused (idempotence is the caller's contract, the hub
//      enforces the guard)
//   3. taskSeq/seq advance past every imported id — the split-brain lesson: two hubs minting from
//      their own counters must never collide again after a merge
// Plus the peer identity fields: /register carries llm+model, /peers returns them — WHO is
// working and on WHAT model is now a bus fact, not a guess.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "./drill-env.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${name}`); };

function spawnHub(port) {
  const dir = mkdtempSync(join(tmpdir(), "trantor-adopt-"));
  mkdirSync(join(dir, ".agent-bus"), { recursive: true });
  const hub = spawn("node", [join(ROOT, "hub.mjs")], {
    env: { ...drillEnv(), RELAY_DATA_DIR: dir, HOME: dir, RELAY_PORT: String(port), PORT: String(port), TRANTOR_NO_UPDATE_CHECK: "1", RELAY_AUTH: "off" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return hub;
}
const mk = (base) => ({
  post: (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json().then(j => ({ status: r.status, ...j }))),
  get: (p) => fetch(base + p).then(r => r.json()),
});

console.log("# trantor adopt/import + peer identity tests");

const P = 47931, hub = spawnHub(P);
await sleep(800);
try {
  const A = mk(`http://127.0.0.1:${P}`);

  // the target hub already has a card whose id will collide with an imported one
  const native = await A.post("/task", { project: "resident", title: "native card", by: "host:resident" });
  const nid = native?.task?.id;

  const imp = await A.post("/import", {
    project: "newproj", by: "owner@test",
    tasks: [
      { id: nid, title: "collides with the native card", status: "done", project: "newproj" },
      { id: 900, title: "clean import", status: "todo", project: "newproj" },
    ],
    events: [
      { ts: Date.now(), type: "created", taskId: nid, title: "collides with the native card", project: "newproj" },
      { ts: Date.now(), type: "moved", taskId: 900, from: "todo", to: "doing", project: "newproj" },
    ],
    messages: [{ id: 1, ts: Date.now(), from: "codex:newproj", to: "all", text: "hello from the old hub", project: "newproj" }],
  });
  ok(imp.ok === true && imp.tasks === 2 && imp.events === 2 && imp.messages === 1, "import lands cards, events and messages");
  ok(imp.remapped === 1, "the colliding card id was remapped");

  const cards = await A.get("/tasks?project=newproj");
  const ids = (cards.tasks ?? []).map(t => t.id);
  ok(ids.length === 2 && !ids.includes(nid) === false ? ids.filter(i => i === nid).length === 0 : true,
     "imported cards never squat on a native id");
  ok((cards.tasks ?? []).every(t => t.project === "newproj"), "imported rows are forced under the adopted project");

  // the remapped card's events followed it
  const remapped = (cards.tasks ?? []).find(t => t.title.startsWith("collides"));
  const thread = await A.get(`/card?id=${remapped.id}`);
  ok((thread.events ?? []).length === 1, "events re-point at the remapped card id");

  // native card untouched
  const nat = await A.get(`/card?id=${nid}`);
  ok(nat.task?.title === "native card", "the native card is untouched");

  // a NEW card after import must not collide with imported ids
  const next = await A.post("/task", { project: "resident", title: "minted after import", by: "host:resident" });
  ok(!ids.includes(next?.task?.id), "taskSeq advanced past every imported id");

  // re-import without force -> refused
  const again = await A.post("/import", { project: "newproj", tasks: [{ id: 1, title: "dupe", status: "todo" }] });
  ok(again.status === 409, "second import without --force is refused");

  // the adoption is on the FEED
  const ev = await A.get("/events?project=newproj&type=project.adopted");
  ok((ev.events ?? []).length === 1, "project.adopted lands on the feed");

  // --- peer identity: llm + model ride registration ---
  await A.post("/register", { session: "host:resident", project: "resident", status: "working", llm: "claude", model: "claude-fable-5" });
  await A.post("/register", { session: "deepseek:resident", project: "resident", llm: "deepseek", model: "deepseek-v4-flash" });
  const peers = await A.get("/peers");
  const me = (peers.peers ?? []).find(p => p.session === "host:resident");
  const ds = (peers.peers ?? []).find(p => p.session === "deepseek:resident");
  ok(me?.llm === "claude" && me?.model === "claude-fable-5", "orchestrator peer carries llm + model");
  ok(ds?.llm === "deepseek" && ds?.model === "deepseek-v4-flash", "crew peer carries llm + model");
  await A.post("/register", { session: "host:resident", project: "resident" });
  const peers2 = await A.get("/peers");
  const me2 = (peers2.peers ?? []).find(p => p.session === "host:resident");
  ok(me2?.model === "claude-fable-5", "a heartbeat without model does not erase the known model");
} catch (e) { fail++; console.log(`  ✗ ${e.message}`); }
finally { hub.kill(); }

// ── warn mode NEVER blocks — it annotates ─────────────────────────────────────────────────────────
// The local-hub incident: a restarted hub 401'd signed requests from a not-yet-enrolled identity
// while UNSIGNED requests passed — warn mode punished exactly the clients doing the right thing.
const PW = 47932, hubW = spawnHub(PW);
hubW.spawnargs && null;
await sleep(800);
try {
  // spawnHub forces RELAY_AUTH off; override with a dedicated warn hub
  hubW.kill();
  const dir2 = mkdtempSync(join(tmpdir(), "trantor-warn-"));
  mkdirSync(join(dir2, ".agent-bus"), { recursive: true });
  const hub2 = spawn("node", [join(ROOT, "hub.mjs")], {
    env: { ...drillEnv(), RELAY_DATA_DIR: dir2, HOME: dir2, RELAY_PORT: String(PW), PORT: String(PW), TRANTOR_NO_UPDATE_CHECK: "1", RELAY_AUTH: "warn" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await sleep(800);
  const { loadOrCreate, signRequest } = await import(join(ROOT, "lib/identity.mjs"));
  process.env.AGENT_BUS_DIR = join(dir2, ".agent-bus");
  const id = loadOrCreate("stranger@test", "human");
  const sig = signRequest(id, { method: "GET", path: "/tasks" });
  const r = await fetch(`http://127.0.0.1:${PW}/tasks`, { headers: sig });
  ok(r.status === 200, "warn mode: a SIGNED request from an unknown identity passes (annotated, not blocked)");
  const r2 = await fetch(`http://127.0.0.1:${PW}/tasks`);
  ok(r2.status === 200, "warn mode: unsigned still passes");
  hub2.kill();
} catch (e) { fail++; console.log(`  ✗ warn mode: ${e.message}`); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

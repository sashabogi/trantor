#!/usr/bin/env node
// trantor bridge tests — two live hubs, a real bridge process between them.
// The bridge exists for hub split-brain (a crew on one hub, the board on another), so the
// tests exercise exactly that: crew-side cards appear on the board hub, board-side OPEN
// cards appear on the crew hub, status moves propagate both ways, restarts never duplicate.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "./drill-env.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${detail}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const HOME = mkdtempSync(join(tmpdir(), "trantor-bridge-"));
const PA = 47961, PB = 47962;
const hubs = [PA, PB].map(port => spawn("node", [join(ROOT, "hub.mjs")], {
  env: { ...drillEnv(), RELAY_DATA_DIR: join(HOME, `hub${port}`), HOME, RELAY_PORT: String(port), TRANTOR_NO_UPDATE_CHECK: "1" },
  stdio: ["ignore", "ignore", "pipe"],
}));
let errs = ""; for (const h of hubs) h.stderr.on("data", d => errs += d);
await sleep(900);

const A = `http://127.0.0.1:${PA}`, B = `http://127.0.0.1:${PB}`;
const api = (base) => ({
  post: (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json()),
  get: (p) => fetch(base + p).then(r => r.json()),
});
const a = api(A), b = api(B);
// One tick = one bridge run. HOME is our temp dir, so the owner identity + map file live there.
const runBridge = () => spawnSync("node", [join(ROOT, "bin", "bridge.mjs"), "brtest", "--from", A, "--to", B, "--once", "--map", join(HOME, "map.json")],
  { encoding: "utf8", timeout: 20000, env: { ...drillEnv(), HOME, AGENT_BUS_DIR: join(HOME, ".agent-bus") } });

console.log("# trantor bridge tests");
try {
  // [1] forward: a crew card appears on the board hub, attribution intact
  const c1 = (await a.post("/task", { project: "brtest", title: "crew: fix RLS gaps", status: "doing", by: "glm:brtest", difficulty: "hard" })).task;
  let r = runBridge();
  ok("bridge tick exits 0", r.status === 0, r.stderr);
  let bTasks = (await b.get("/tasks?project=brtest")).tasks;
  const m1 = bTasks.find(t => t.title === "crew: fix RLS gaps");
  ok("crew card mirrored to board hub", !!m1 && m1.status === "doing", JSON.stringify(bTasks.map(t => t.title)));
  ok("attribution (by) preserved", m1?.by === "glm:brtest", m1?.by);
  ok("difficulty preserved", m1?.difficulty === "hard", m1?.difficulty);

  // [2] no duplicates on repeat ticks (mapping works, restarts safe — fresh process each tick)
  runBridge(); runBridge();
  bTasks = (await b.get("/tasks?project=brtest")).tasks;
  ok("three ticks, still ONE mirror (no dupes)", bTasks.filter(t => t.title === "crew: fix RLS gaps").length === 1, `got ${bTasks.length}`);

  // [3] forward status move propagates
  await a.post("/task/update", { id: c1.id, status: "testing", by: "glm:brtest" });
  runBridge();
  bTasks = (await b.get("/tasks?project=brtest")).tasks;
  ok("status move A→B propagates", bTasks.find(t => t.title === "crew: fix RLS gaps")?.status === "testing");

  // [4] reverse: an OPEN board card appears on the crew hub; a done card does not
  const o1 = (await b.post("/task", { project: "brtest", title: "B. assistant surface", status: "todo", by: "MacBook:brtest" })).task;
  await b.post("/task", { project: "brtest", title: "ancient done card", status: "done", by: "MacBook:brtest" });
  runBridge();
  let aTasks = (await a.get("/tasks?project=brtest")).tasks;
  ok("open board card mirrored to crew hub", aTasks.some(t => t.title === "B. assistant surface" && t.status === "todo"), JSON.stringify(aTasks.map(t => t.title)));
  ok("done board card NOT mirrored", !aTasks.some(t => t.title === "ancient done card"));

  // [5] reverse status move propagates back to the board (crew picks up the assignment)
  const m2 = aTasks.find(t => t.title === "B. assistant surface");
  await a.post("/task/update", { id: m2.id, status: "doing", by: "codex:brtest" });
  runBridge();
  const o1b = (await b.get("/tasks?project=brtest")).tasks.find(t => t.id === o1.id);
  ok("crew picking up a mirrored assignment reflects on the board", o1b?.status === "doing", o1b?.status);

  // [6] the mirror write itself never echoes back as a change (stable across further ticks)
  runBridge(); runBridge();
  const stableA = (await a.get("/tasks?project=brtest")).tasks.length;
  const stableB = (await b.get("/tasks?project=brtest")).tasks.length;
  runBridge();
  ok("card counts stable across idle ticks", (await a.get("/tasks?project=brtest")).tasks.length === stableA
    && (await b.get("/tasks?project=brtest")).tasks.length === stableB);

  // [7] --since cutoff: pre-existing A cards older than the cutoff stay unmirrored
  await a.post("/task", { project: "brtest", title: "old history card", status: "done", by: "old:brtest" });
  await sleep(30);
  const cutoff = Date.now() + 60000;                      // everything so far is older than this
  const r7 = spawnSync("node", [join(ROOT, "bin", "bridge.mjs"), "brtest", "--from", A, "--to", B, "--once",
    "--since", String(cutoff), "--map", join(HOME, "map2.json")],
    { encoding: "utf8", timeout: 20000, env: { ...drillEnv(), HOME, AGENT_BUS_DIR: join(HOME, ".agent-bus") } });
  ok("--since respected (fresh map, nothing older mirrored)", r7.status === 0 && !(await b.get("/tasks?project=brtest")).tasks.some(t => t.title === "old history card"), r7.stderr);

  ok("map file persisted", readFileSync(join(HOME, "map.json"), "utf8").includes("aId"));

  // [8] shared-ancestry seeding: same id + title on both hubs = ONE card, not a duplicate.
  // Passive for stale divergence; a crew-touched card (updated ≥ --since) pushes its status.
  const seedProj = "brseed";
  // stale diverged twin: A says done, B says failed — must be left alone
  const s1a = (await a.post("/task", { project: seedProj, title: "old shared card", status: "done", by: "old:x" })).task;
  await b.post("/task", { project: seedProj, title: "old shared card", status: "failed", by: "old:x" });
  await sleep(50);
  const cutoff8 = Date.now();
  await sleep(50);
  // live twin: crew re-activated it on A after the cutoff — B must follow
  const s2a = (await a.post("/task", { project: seedProj, title: "reactivated card", status: "todo", by: "old:x" })).task;
  await b.post("/task", { project: seedProj, title: "reactivated card", status: "failed", by: "old:x" });
  await a.post("/task/update", { id: s2a.id, status: "doing", by: "glm:brseed" });
  const r8 = spawnSync("node", [join(ROOT, "bin", "bridge.mjs"), seedProj, "--from", A, "--to", B, "--once",
    "--since", String(cutoff8), "--map", join(HOME, "map3.json")],
    { encoding: "utf8", timeout: 20000, env: { ...drillEnv(), HOME, AGENT_BUS_DIR: join(HOME, ".agent-bus") } });
  ok("seed tick exits 0", r8.status === 0, r8.stderr);
  const bSeed = (await b.get(`/tasks?project=${seedProj}`)).tasks;
  ok("shared twins are paired, not duplicated", bSeed.filter(t => t.title === "old shared card").length === 1
    && bSeed.filter(t => t.title === "reactivated card").length === 1, JSON.stringify(bSeed.map(t => t.title)));
  ok("stale divergence left untouched (no mass rewrite)", bSeed.find(t => t.title === "old shared card")?.status === "failed");
  ok("crew-touched shared card pushes its status", bSeed.find(t => t.title === "reactivated card")?.status === "doing",
    bSeed.find(t => t.title === "reactivated card")?.status);
  void s1a;

  // [9] reverse window: an open B card older than the window stays off the crew board
  const oldOpen = (await b.post("/task", { project: seedProj, title: "months-old open backlog", status: "todo", by: "old:x" })).task;
  const r9 = spawnSync("node", [join(ROOT, "bin", "bridge.mjs"), seedProj, "--from", A, "--to", B, "--once",
    "--since", String(cutoff8), "--reverse-window", "0.00001",   // ~36ms window: everything is too old
    "--map", join(HOME, "map3.json")],
    { encoding: "utf8", timeout: 20000, env: { ...drillEnv(), HOME, AGENT_BUS_DIR: join(HOME, ".agent-bus") } });
  ok("reverse window respected (old open card not mirrored)", r9.status === 0
    && !(await a.get(`/tasks?project=${seedProj}`)).tasks.some(t => t.title === "months-old open backlog"), r9.stderr);
  void oldOpen;
} catch (e) {
  fail++; console.log(`  ✗ threw: ${e.message}\n${errs.slice(-400)}`);
} finally {
  for (const h of hubs) { try { h.kill(); } catch {} }
  try { rmSync(HOME, { recursive: true, force: true }); } catch {}
}
ok("hubs clean stderr", !/TypeError|ReferenceError|not defined/.test(errs), errs.slice(0, 300));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

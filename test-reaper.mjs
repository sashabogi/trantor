#!/usr/bin/env node
// trantor stale-card reaper + manual sweep tests (2026-07-20).
//
// The board only advanced via active carding channels (crew turn reports, TodoWrite, git commit,
// SubagentStart/Stop, focus hook); a broken channel — a crew seat torn down mid-flight, a fork that
// crashed, a session that died — orphaned its card in whatever lane it was in FOREVER. prunePeers only
// ever closed the ONE focus card, and only after a 6h peer TTL. hub.mjs now runs reapStaleCards():
//   (a) a focus card closes to "done" once its session is OFFLINE past FOCUS_OFFLINE_MS (not 6h);
//   (b) a doing work card whose OWNER is OFFLINE past REAP_GRACE_MS moves to "stale" with a card-log
//       explanation — never a testing card (that is waiting for the operator) or an online owner's card;
//   plus POST /sweep: the explicit "live seat forgot its card" path (preview-first, owner-liveness-agnostic).
// These spin up the REAL hub.mjs with tiny time windows and assert the durable contract.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "./drill-env.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${detail}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function spawnHub(port, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "trantor-reaper-"));
  mkdirSync(join(dir, ".agent-bus"), { recursive: true });
  const hub = spawn("node", [join(ROOT, "hub.mjs")], {
    env: { ...drillEnv(), RELAY_DATA_DIR: dir, HOME: dir, RELAY_PORT: String(port), PORT: String(port), TRANTOR_NO_UPDATE_CHECK: "1", ...extraEnv },
    stdio: ["ignore", "ignore", "pipe"],
  });
  hub._dir = dir;
  return hub;
}
const mk = (base) => ({
  post: (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json()),
  get: (p) => fetch(base + p).then(r => r.json()),
});

console.log("# trantor stale-card reaper + sweep tests");

// ── Hub A: the automatic reaper (offline owner → stale; focus → done) with tiny windows ─────────────
const PA = 47861, hubA = spawnHub(PA, {
  RELAY_ONLINE_MS: "250", RELAY_REAP_GRACE_MS: "250", RELAY_FOCUS_OFFLINE_MS: "250", RELAY_REAP_INTERVAL_MS: "120",
});
let errA = ""; hubA.stderr.on("data", d => errA += d);
await sleep(800);
try {
  const A = mk(`http://127.0.0.1:${PA}`); const PROJ = "reapA";
  const tasksFor = async (proj = PROJ) => (await A.get(`/tasks?project=${proj}`)).tasks;

  // an offline-owner crew work card → stale (owner "codex:reapA" is touched at create, then lapses offline)
  const c = await A.post("/task", { project: PROJ, title: "abandoned crew work", status: "doing", assignee: "codex:reapA", by: "codex:reapA" });
  ok("work card starts doing", c?.task?.status === "doing", `(got "${c?.task?.status}")`);
  const wid = c?.task?.id;

  // testing is a declared wait for the operator; even an offline owner cannot make it stale
  const t = await A.post("/task", { project: PROJ, title: "waiting for operator drill", status: "testing", assignee: "glm:reapA", by: "glm:reapA" });
  ok("operator drill starts testing", t?.task?.status === "testing", `(got "${t?.task?.status}")`);
  const tid = t?.task?.id;

  // a focus card for a session that will go offline
  await A.post("/focus", { session: "host:reapA", project: PROJ, title: "focus work that ends", by: "host:reapA" });
  let f = (await tasksFor()).filter(t => t.source === "session");
  ok("focus card starts doing", f[0]?.status === "doing", `(got "${f[0]?.status}")`);

  // wait past ONLINE_MS + REAP_GRACE_MS + a couple reaper ticks — NO reads that could trigger prunePeers
  await sleep(900);
  const after = await tasksFor();
  const work = after.find(t => t.id === wid);
  ok("offline-owner doing card → stale", work?.status === "stale", `(got "${work?.status}")`);
  ok("reaped card records the move in history", (work?.history || []).some(h => h.to === "stale" && h.by === "reaper"));
  const reaperLog = (work?.log || []).find(l => l.by === "reaper");
  ok("reaped card log names the reason", reaperLog?.text.includes("owner offline → stale"), `(got "${reaperLog?.text}")`);
  ok("reaped card log records owner last seen", reaperLog?.text.includes("owner last seen"), `(got "${reaperLog?.text}")`);
  const testing = after.find(t => t.id === tid);
  ok("offline-owner testing card stays in testing", testing?.status === "testing", `(got "${testing?.status}")`);
  ok("testing card has no reaper stale log", !(testing?.log || []).some(l => l.by === "reaper"));
  f = after.filter(t => t.source === "session");
  ok("focus card auto-closed to done by the reaper (no /peers read)", f[0]?.status === "done", `(got "${f[0]?.status}")`);
} catch (e) { fail++; console.log("  ✗ hubA threw:", e?.message || e, errA ? `\n  stderr: ${errA}` : ""); }
finally { hubA.kill(); try { rmSync(hubA._dir, { recursive: true, force: true }); } catch {} }

// ── Hub B: the reaper must NOT touch a card whose owner is still ONLINE ──────────────────────────────
const PB = 47862, hubB = spawnHub(PB, {
  RELAY_ONLINE_MS: "8000", RELAY_REAP_GRACE_MS: "200", RELAY_REAP_INTERVAL_MS: "120",
});
let errB = ""; hubB.stderr.on("data", d => errB += d);
await sleep(800);
try {
  const B = mk(`http://127.0.0.1:${PB}`); const PROJ = "reapB";
  const c = await B.post("/task", { project: PROJ, title: "a live long-running task", status: "doing", assignee: "codex:reapB", by: "codex:reapB" });
  const wid = c?.task?.id;
  // owner stays online (ONLINE_MS 8s ≫ test); grace is 200ms so the reaper WILL consider it, and must skip it
  await sleep(700);
  const work = (await B.get(`/tasks?project=${PROJ}`)).tasks.find(t => t.id === wid);
  ok("online-owner doing card is NOT reaped (live long task safe)", work?.status === "doing", `(got "${work?.status}")`);
} catch (e) { fail++; console.log("  ✗ hubB threw:", e?.message || e, errB ? `\n  stderr: ${errB}` : ""); }
finally { hubB.kill(); try { rmSync(hubB._dir, { recursive: true, force: true }); } catch {} }

// ── Hub C: manual /sweep — preview (dryRun), real move, project scoping, and triage OUT of stale ─────
// Auto-reaper disabled by huge windows so ONLY /sweep acts.
const PC = 47863, hubC = spawnHub(PC, {
  RELAY_ONLINE_MS: "999999", RELAY_REAP_GRACE_MS: "999999", RELAY_REAP_INTERVAL_MS: "999999",
});
let errC = ""; hubC.stderr.on("data", d => errC += d);
await sleep(800);
try {
  const C = mk(`http://127.0.0.1:${PC}`);
  // project A: 2 doing + 1 testing + 1 done + 1 todo ; project B: 1 doing (must be untouched by a scoped sweep)
  await C.post("/task", { project: "swA", title: "doing one", status: "doing", assignee: "codex:swA", by: "codex:swA" });
  await C.post("/task", { project: "swA", title: "doing two", status: "doing", assignee: "glm:swA", by: "glm:swA" });
  await C.post("/task", { project: "swA", title: "testing one", status: "testing", assignee: "kimi:swA", by: "kimi:swA" });
  await C.post("/task", { project: "swA", title: "already done", status: "done", assignee: "codex:swA", by: "codex:swA" });
  await C.post("/task", { project: "swA", title: "still queued", status: "todo", assignee: "codex:swA", by: "codex:swA" });
  await C.post("/task", { project: "swB", title: "other project doing", status: "doing", assignee: "codex:swB", by: "codex:swB" });

  // dryRun on project swA (olderMs:0 → everything doing/testing qualifies) — 3 candidates, NOTHING changes
  const dry = await C.post("/sweep", { project: "swA", olderMs: 0, dryRun: true });
  ok("dryRun reports the 3 doing/testing candidates", dry?.count === 3, `(got ${dry?.count})`);
  ok("dryRun changes nothing", dry?.dryRun === true);
  let swA = (await C.get("/tasks?project=swA")).tasks;
  ok("after dryRun no card is stale yet", swA.filter(t => t.status === "stale").length === 0);

  // real sweep of swA
  const real = await C.post("/sweep", { project: "swA", olderMs: 0, by: "host:swA" });
  ok("real sweep stales 3 cards", real?.swept === 3, `(got ${real?.swept})`);
  swA = (await C.get("/tasks?project=swA")).tasks;
  ok("both doing cards are now stale", swA.filter(t => t.status === "stale").length === 3);
  ok("the done card is untouched", swA.find(t => t.title === "already done")?.status === "done");
  ok("the todo card is untouched", swA.find(t => t.title === "still queued")?.status === "todo");

  // project scoping: swB's doing card must be untouched by the swA sweep
  const swB = (await C.get("/tasks?project=swB")).tasks;
  ok("a different project's card is NOT swept", swB.find(t => t.title === "other project doing")?.status === "doing", `(got "${swB[0]?.status}")`);

  // triage: a stale card can be re-queued to todo and closed to done via /task/update
  const staleId = swA.find(t => t.status === "stale")?.id;
  const requeued = await C.post("/task/update", { id: staleId, status: "todo", by: "host:swA" });
  ok("stale card can be re-queued to todo", requeued?.task?.status === "todo", `(got "${requeued?.task?.status}")`);
  const staleId2 = swA.filter(t => t.status === "stale").map(t => t.id).find(id => id !== staleId);
  const discarded = await C.post("/task/update", { id: staleId2, status: "done", by: "host:swA" });
  ok("stale card can be discarded to done", discarded?.task?.status === "done", `(got "${discarded?.task?.status}")`);
} catch (e) { fail++; console.log("  ✗ hubC threw:", e?.message || e, errC ? `\n  stderr: ${errC}` : ""); }
finally { hubC.kill(); try { rmSync(hubC._dir, { recursive: true, force: true }); } catch {} }

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);

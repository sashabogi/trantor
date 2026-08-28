#!/usr/bin/env node
// trantor outstanding-contract drills — an orchestrator must be able to ask what it is still owed,
// and must not park while a dispatched contract is stalled.
//
// 0.17.85 made a seat REPORT its outcome. That closes "done and nobody knows" only while the
// orchestrator is listening. Two gaps remain, both reported from live sessions:
//   1. No ledger. The orchestrator dispatches N contracts and has no way to ask which are still
//      open. Silence carries no information: a seat still working and a seat that died look the
//      same, so the human ends up being the one who remembers.
//   2. No metronome. A session parks at a Stop and stays parked, even when it is waiting on a seat
//      that is down. Someone has to poke it.
//
// These drills run the REAL hub and the REAL stop hook.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log("# trantor outstanding-contract drills");

const PORT = 47931;
const dir = mkdtempSync(join(tmpdir(), "trantor-contracts-"));
mkdirSync(join(dir, ".agent-bus"), { recursive: true });
const hub = spawn("node", [join(ROOT, "hub.mjs")], {
  env: { ...process.env, RELAY_DATA_DIR: dir, HOME: dir, RELAY_PORT: String(PORT), PORT: String(PORT), TRANTOR_NO_UPDATE_CHECK: "1" },
  stdio: ["ignore", "ignore", "pipe"],
});
await sleep(900);
const BASE = `http://127.0.0.1:${PORT}`;
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json()).catch(e => ({ error: String(e) }));
const get = (p) => fetch(BASE + p).then(r => r.json()).catch(e => ({ error: String(e) }));

const ORCH = "host:ctr", SEAT = "codex:ctr", SEAT2 = "glm:ctr", PROJ = "ctr";

await post("/register", { session: ORCH, project: PROJ, status: "orchestrating" });
await post("/register", { session: SEAT, project: PROJ, status: "active in ctr" });
await post("/register", { session: SEAT2, project: PROJ, status: "active in ctr" });

console.log("\nThe orchestrator can ask what it is still owed:");
const c1 = await post("/send", { from: ORCH, to: SEAT, project: PROJ, text: "land the first 40 cardiology rules" });
const c2 = await post("/send", { from: ORCH, to: SEAT2, project: PROJ, text: "write the derm formulary" });
await post("/send", { from: ORCH, to: "all", project: PROJ, text: "morning, crew" });   // broadcast: never a contract
{
  const r = await get(`/contracts?session=${encodeURIComponent(ORCH)}&project=${PROJ}`);
  ok("the hub answers /contracts at all", !r.error && Array.isArray(r.contracts), JSON.stringify(r).slice(0, 120));
  const open = (r.contracts || []).filter(c => !c.answered);
  ok("both dispatched contracts are outstanding", open.length === 2, `${open.length} open`);
  ok("a broadcast is NOT counted as a contract", (r.contracts || []).length > 0 && (r.contracts || []).every(c => c.to !== "all"));
  ok("each one says who owes it and what was asked",
    open.length > 0 && open.every(c => c.to && /cardiology|derm/.test(c.text || "")), JSON.stringify(open).slice(0, 160));
  ok("…and how long it has been outstanding", open.length > 0 && open.every(c => typeof c.ageMs === "number"));
}

console.log("\nAn outcome closes the contract it answers, and only that one:");
await post("/send", { from: SEAT, to: ORCH, project: PROJ, text: "✅ done on codex:ctr (exit 0, 12s)", re: c1.id });
{
  const r = await get(`/contracts?session=${encodeURIComponent(ORCH)}&project=${PROJ}`);
  const byId = Object.fromEntries((r.contracts || []).map(c => [c.id, c]));
  ok("the answered contract is marked answered", byId[c1.id]?.answered === true, JSON.stringify(byId[c1.id] || {}).slice(0, 140));
  ok("…carrying the outcome text so the orchestrator need not go digging",
    /done on codex/.test(byId[c1.id]?.answer?.text || ""), JSON.stringify(byId[c1.id]?.answer || {}).slice(0, 120));
  ok("the OTHER contract is still open", byId[c2.id]?.answered === false);
}

console.log("\nA contract whose seat has gone quiet is flagged, because waiting on it is futile:");
{
  const r = await get(`/contracts?session=${encodeURIComponent(ORCH)}&project=${PROJ}`);
  const open = (r.contracts || []).find(c => !c.answered);
  ok("the open contract reports its assignee's health", open && typeof open.assigneeOnline === "boolean",
    JSON.stringify(open || {}).slice(0, 160));
  ok("…and the assignee's last known status", open && typeof open.assigneeStatus === "string");
}

console.log("\nA session does not park while a dispatched contract is stalled:");
{
  // The REAL Stop hook, against this hub, for a session that is owed something by a seat that is
  // not coming back. It must refuse the stop ONCE and say what is outstanding.
  const { writeFileSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const w = mkdtempSync(join(tmpdir(), "trantor-ctrstop-"));
  const BUS = join(w, "bus"); mkdirSync(BUS, { recursive: true });
  const repo = join(w, "ctr"); mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(BUS, "config.json"), JSON.stringify({ url: BASE, hubs: { ctr: BASE } }));
  const out = await new Promise((resolve) => {
    const kid = spawn(process.execPath, [join(ROOT, "hooks", "stop-inbox.mjs")], {
      cwd: ROOT, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, AGENT_BUS_DIR: BUS, CLAUDE_PROJECT_DIR: repo, RELAY_HOST_ID: "host",
             RELAY_SESSION: "", RELAY_PROJECT: "", RELAY_URL: "",
             TRANTOR_CONTRACT_OVERDUE_MS: "0" },   // everything open counts as overdue, for the drill
    });
    let so = ""; kid.stdout.on("data", d => (so += d));
    kid.on("close", () => resolve(so));
    kid.stdin.end(JSON.stringify({ session_id: "ctr-stop-1", cwd: repo, stop_hook_active: false }));
    setTimeout(() => { try { kid.kill("SIGKILL"); } catch {} }, 15000).unref?.();
  });
  let o = {}; try { o = JSON.parse(out || "{}"); } catch {}
  ok("the stop is blocked while a contract is outstanding", o.decision === "block", out.slice(0, 200));
  ok("…and the reason names what is owed and by whom",
    /outstanding|owe|contract/i.test(o.reason || "") && /glm:ctr/.test(o.reason || ""), (o.reason || "").slice(0, 220));
  if (o.reason) console.log(`     ↳ injected: ${JSON.stringify(String(o.reason).split("\n")[0].slice(0, 150))}`);

  // and it must never trap the session
  const out2 = await new Promise((resolve) => {
    const kid = spawn(process.execPath, [join(ROOT, "hooks", "stop-inbox.mjs")], {
      cwd: ROOT, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, AGENT_BUS_DIR: BUS, CLAUDE_PROJECT_DIR: repo, RELAY_HOST_ID: "host",
             RELAY_SESSION: "", RELAY_PROJECT: "", RELAY_URL: "", TRANTOR_CONTRACT_OVERDUE_MS: "0" },
    });
    let so = ""; kid.stdout.on("data", d => (so += d));
    kid.on("close", () => resolve(so));
    kid.stdin.end(JSON.stringify({ session_id: "ctr-stop-1", cwd: repo, stop_hook_active: true }));
    setTimeout(() => { try { kid.kill("SIGKILL"); } catch {} }, 15000).unref?.();
  });
  let o2 = {}; try { o2 = JSON.parse(out2 || "{}"); } catch {}
  ok("it never blocks twice in one stop-cycle (no trapped session)", o2.decision !== "block", out2.slice(0, 160));
}

console.log("\nAn outcome is threaded to the contract it names, not merely the oldest:");
{
  // Ordered last on purpose: these add unread mail for the orchestrator, which the stop drill above
  // must not see (an inbox message would take that path instead of the contracts path).
  const c3 = await post("/send", { from: ORCH, to: SEAT, project: PROJ, text: "second job: the ortho set" });
  const c4 = await post("/send", { from: ORCH, to: SEAT, project: PROJ, text: "third job: the endo set" });
  await post("/send", { from: SEAT, to: ORCH, project: PROJ, text: "✅ done (exit 0)", re: c4.id });
  const r2 = await get(`/contracts?session=${encodeURIComponent(ORCH)}&project=${PROJ}`);
  const m2 = Object.fromEntries((r2.contracts || []).map(c => [c.id, c]));
  ok("an out-of-order outcome closes the contract it names, not the oldest",
    m2[c4.id]?.answered === true && m2[c3.id]?.answered === false,
    `c3=${m2[c3.id]?.answered} c4=${m2[c4.id]?.answered}`);
}

// ---- the lifecycle: waiting → stalled → abandoned -------------------------------------------
// A contract closes only when the ASSIGNEE answers, so a seat that does the work and then dies never
// closes one. A live session found 16 such ghosts in a day, each with its files already on disk, and
// the stop guard then nagged about them at every stop forever. These drills run a SECOND hub with
// tiny windows and assert the whole lifecycle, including that quiet is never treated as an answer.
console.log("\nA contract whose assignee dies walks a lifecycle instead of hanging open forever:");
const PORT2 = 47932;
const dir2 = mkdtempSync(join(tmpdir(), "trantor-ctrlife-"));
mkdirSync(join(dir2, ".agent-bus"), { recursive: true });
const life = {
  RELAY_DATA_DIR: dir2, HOME: dir2, RELAY_PORT: String(PORT2), PORT: String(PORT2),
  TRANTOR_NO_UPDATE_CHECK: "1",
  RELAY_ONLINE_MS: "600",                  // offline after 0.6s quiet
  RELAY_CONTRACT_ABANDON_MS: "2500",       // abandoned after 2.5s quiet
  RELAY_REAP_INTERVAL_MS: "300",           // sweep fast
};
let hub2 = spawn("node", [join(ROOT, "hub.mjs")], { env: { ...process.env, ...life }, stdio: ["ignore", "ignore", "pipe"] });
await sleep(900);
const BASE2 = `http://127.0.0.1:${PORT2}`;
const post2 = (p, b) => fetch(BASE2 + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json()).catch(e => ({ error: String(e) }));
const get2 = (p) => fetch(BASE2 + p).then(r => r.json()).catch(e => ({ error: String(e) }));
const ctr2 = (sess) => get2(`/contracts?session=${encodeURIComponent(sess)}`);

const O = "host:life", DEAD = "codex:life", LIVE = "glm:life", PROJ2 = "life";
await post2("/register", { session: O, project: PROJ2, status: "orchestrating" });
await post2("/register", { session: DEAD, project: PROJ2, status: "working" });
await post2("/register", { session: LIVE, project: PROJ2, status: "working" });

const gone = await post2("/send", { from: O, to: DEAD, project: PROJ2, text: "port the ortho ruleset" });
const kept = await post2("/send", { from: O, to: LIVE, project: PROJ2, text: "port the endo ruleset" });

{
  const r = await ctr2(O);
  const m = Object.fromEntries((r.contracts || []).map(c => [c.id, c]));
  ok("a fresh contract to a live seat is WAITING, not stalled",
    m[gone.id]?.disposition === "waiting" && m[kept.id]?.disposition === "waiting",
    `${m[gone.id]?.disposition} / ${m[kept.id]?.disposition}`);
  ok("…and waiting contracts count as open work", r.open === 2 && r.waiting === 2, JSON.stringify({ open: r.open, waiting: r.waiting }));
}

// DEAD stops heartbeating; LIVE keeps checking in. Only the dead one should decay. LIVE's heartbeat
// runs on a timer rather than hand-paced awaits: a drill that lets its own control seat lapse is
// measuring the test's timing, not the hub's behaviour.
const beat = setInterval(() => { post2("/register", { session: LIVE, project: PROJ2, status: "working" }); }, 200);
await sleep(1600);
{
  const r = await ctr2(O);
  const m = Object.fromEntries((r.contracts || []).map(c => [c.id, c]));
  ok("the dead seat's contract goes STALLED once it drops offline", m[gone.id]?.disposition === "stalled", m[gone.id]?.disposition);
  ok("…while the live seat's contract is untouched", m[kept.id]?.disposition === "waiting", m[kept.id]?.disposition);
}

// Past the abandon window the ghost stops being work. LIVE's heartbeat is still running.
await sleep(2300);
{
  const r = await ctr2(O);
  const m = Object.fromEntries([...(r.contracts || []), ...(r.abandonedContracts || [])].map(c => [c.id, c]));
  ok("a contract nobody can ever answer becomes ABANDONED", m[gone.id]?.disposition === "abandoned", m[gone.id]?.disposition);
  // The split is what reaches a session whose hooks are pinned to an older release: an old stop hook
  // iterates `contracts` with its own predicate, so a ghost left in that array keeps blocking forever
  // no matter what the hub calls it.
  ok("…and it LEAVES the contracts array, so an old pinned stop hook stops blocking on it",
    !(r.contracts || []).some(c => Number(c.id) === Number(gone.id)),
    JSON.stringify((r.contracts || []).map(c => c.id)));
  ok("…riding in abandonedContracts instead, so the ledger can still show what died",
    (r.abandonedContracts || []).some(c => Number(c.id) === Number(gone.id)));
  ok("…it stops counting as open work, so it stops nagging every future session",
    r.open === 1 && r.abandoned === 1, JSON.stringify({ open: r.open, abandoned: r.abandoned }));
  ok("…but it is still LISTED, with the evidence, so the ledger can show what died",
    !!m[gone.id] && m[gone.id].answered === false && /never seen|last seen/i.test(m[gone.id]?.reaped?.reason || ""),
    JSON.stringify(m[gone.id]?.reaped || null));
  ok("…and it is NEVER marked answered — quiet is not an outcome", m[gone.id]?.answered === false && m[gone.id]?.answer === null);
  ok("the live seat's contract is still open the whole time", m[kept.id]?.disposition === "waiting", m[kept.id]?.disposition);
}

{
  const ev = await get2(`/events?limit=200`);
  const list = ev?.events || ev || [];
  const found = (Array.isArray(list) ? list : []).some(e => e.type === "contract.abandoned" && Number(e.msgId) === Number(gone.id));
  ok("the reaper records the abandonment as an event, so it shows up in the FEED", found,
    JSON.stringify((Array.isArray(list) ? list : []).map(e => e.type).slice(-8)));
}

clearInterval(beat);

// The reap is EVIDENCE, not a tombstone: a seat that comes back still closes its own contract.
await post2("/send", { from: DEAD, to: O, project: PROJ2, text: "✅ ortho done (exit 0)", re: gone.id });
{
  const r = await ctr2(O);
  const m = Object.fromEntries([...(r.contracts || []), ...(r.abandonedContracts || [])].map(c => [c.id, c]));
  ok("a late outcome still closes an abandoned contract — the reap is evidence, not a tombstone",
    m[gone.id]?.disposition === "answered" && m[gone.id]?.answered === true,
    `${m[gone.id]?.disposition}`);
}

// Contracts that could never be answered must never have been contracts.
{
  const self = await post2("/send", { from: O, to: O, project: PROJ2, text: "note to self" });
  await sleep(400);
  const r = await ctr2(O);
  const ids = new Set((r.contracts || []).map(c => Number(c.id)));
  ok("a message to YOURSELF is never a contract (it could never be answered)", !ids.has(Number(self.id)));
  ok("…and neither is anything addressed to a hub:* pseudo-identity",
    (r.contracts || []).every(c => !String(c.to).startsWith("hub:")));
}

// Persistence: the whole point of the kv key. A restart must not resurrect the ghost backlog.
{
  const before = await ctr2(O);
  const reapedIn = (r) => [...(r.contracts || []), ...(r.abandonedContracts || [])].filter(c => c.reaped).length;
  const abandonedBefore = reapedIn(before);
  hub2.kill("SIGKILL");
  await sleep(400);
  hub2 = spawn("node", [join(ROOT, "hub.mjs")], { env: { ...process.env, ...life }, stdio: ["ignore", "ignore", "pipe"] });
  await sleep(1200);
  const after = await ctr2(O);
  const abandonedAfter = reapedIn(after);
  ok("a hub restart remembers what it already reaped (no re-announced ghost backlog)",
    abandonedAfter >= abandonedBefore && abandonedBefore > 0,
    `before=${abandonedBefore} after=${abandonedAfter}`);
}

// The stop guard must not block on a ghost it can never resolve.
{
  const { spawnSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const w = mkdtempSync(join(tmpdir(), "trantor-lifestop-"));
  const BUS = join(w, "bus"); mkdirSync(BUS, { recursive: true });
  const repo = join(w, "life"); mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(BUS, "config.json"), JSON.stringify({ url: BASE2, hubs: { life: BASE2 } }));
  // GHOST dispatches to a seat that never checks in again, then we let it decay all the way through.
  const GHOST = "host:ghost";
  await post2("/register", { session: GHOST, project: PROJ2, status: "orchestrating" });
  await post2("/send", { from: GHOST, to: DEAD, project: PROJ2, text: "a job for a seat that is gone" });
  await sleep(3200);   // past the abandon window; the reaper sweeps every 300ms
  // Drain GHOST's mail first. The unread-DM guard runs BEFORE the contracts guard, so an overseer
  // warning sitting in its inbox would block the stop for a reason this drill is not about — and the
  // drill would then "pass" the wrong assertion. A consuming read (no peek) empties it.
  await get2(`/inbox?session=${encodeURIComponent(GHOST)}`);
  const runStop = (active) => new Promise((resolve) => {
    const kid = spawn(process.execPath, [join(ROOT, "hooks", "stop-inbox.mjs")], {
      cwd: ROOT, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, AGENT_BUS_DIR: BUS, CLAUDE_PROJECT_DIR: repo, RELAY_HOST_ID: "host",
             RELAY_SESSION: GHOST, RELAY_PROJECT: PROJ2, RELAY_URL: BASE2,
             TRANTOR_CONTRACT_OVERDUE_MS: "0" },
    });
    let so = ""; kid.stdout.on("data", d => (so += d));
    kid.on("close", () => resolve(so));
    kid.stdin.end(JSON.stringify({ session_id: "life-stop-1", cwd: repo, stop_hook_active: active }));
    setTimeout(() => { try { kid.kill("SIGKILL"); } catch {} }, 15000).unref?.();
  });
  const out = await runStop(false);
  let o = {}; try { o = JSON.parse(out || "{}"); } catch {}
  ok("the stop guard does NOT block on an abandoned contract (the ghost-nag is over)",
    o.decision !== "block", (o.reason || out || "").slice(0, 200));
}

// ---- superseded: an alive seat that moved on must not strand a row forever -------------------
// The bug this drills, from production (#10573): a courtesy send to a seat that then restarted.
// The seat came back HEALTHY and answered every later contract with an explicit `re`, so the row
// could never be answered (nothing untagged ever reached the loose-reply fallback) and could never
// be abandoned (`abandoned` keys on the assignee being GONE). It blocked the dispatcher's stop hook
// every turn across two consecutive sessions. It must reach a terminal state on its own.
console.log("\nA row an alive seat has moved on from is settled, not nagged forever:");
{
  const SUP = "kimi:life";
  await post2("/register", { session: SUP, project: PROJ2, status: "working" });
  const stranded = await post2("/send", { from: O, to: SUP, project: PROJ2, text: "courtesy: verified my side, nothing needed from you" });

  // Age the row past the abandon window while the seat stays demonstrably ALIVE — that pairing is
  // the whole bug. Re-registering inside the loop is the heartbeat.
  for (let i = 0; i < 6; i++) { await sleep(550); await post2("/register", { session: SUP, project: PROJ2, status: "working" }); }

  const realJob = await post2("/send", { from: O, to: SUP, project: PROJ2, text: "the actual job: port the cardio ruleset" });
  await post2("/send", { from: SUP, to: O, project: PROJ2, text: "✅ done (exit 0)", re: realJob.id });
  await post2("/register", { session: SUP, project: PROJ2, status: "working" });

  const r = await ctr2(O);
  const open = Object.fromEntries((r.contracts || []).map(c => [c.id, c]));
  const sup = Object.fromEntries((r.supersededContracts || []).map(c => [c.id, c]));
  ok("the stranded row leaves `contracts`, so a PINNED older stop hook stops blocking on it",
    open[stranded.id] === undefined, JSON.stringify(open[stranded.id] || {}).slice(0, 160));
  ok("…and rides in `supersededContracts`, so the ledger still shows it",
    sup[stranded.id]?.disposition === "superseded", JSON.stringify(r.supersededContracts || []).slice(0, 200));
  ok("the assignee is reported ALIVE — this is not abandonment wearing a new name",
    sup[stranded.id]?.assigneeOnline === true, `online=${sup[stranded.id]?.assigneeOnline}`);
  ok("the newer contract it moved on to is still answered", open[realJob.id]?.answered === true);

  // and the guard must not block on it
  const { writeFileSync } = await import("node:fs");
  const w3 = mkdtempSync(join(tmpdir(), "trantor-supstop-"));
  const BUS3 = join(w3, "bus"); mkdirSync(BUS3, { recursive: true });
  const repo3 = join(w3, "life"); mkdirSync(repo3, { recursive: true });
  const { spawnSync: sp3 } = await import("node:child_process");
  sp3("git", ["init", "-q"], { cwd: repo3 });
  writeFileSync(join(BUS3, "config.json"), JSON.stringify({ url: BASE2, hubs: { life: BASE2 } }));
  await get2(`/inbox?session=${encodeURIComponent(O)}`);   // consuming read: unread mail would block for another reason
  const so = await new Promise((resolve) => {
    const kid = spawn(process.execPath, [join(ROOT, "hooks", "stop-inbox.mjs")], {
      cwd: ROOT, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, AGENT_BUS_DIR: BUS3, CLAUDE_PROJECT_DIR: repo3, RELAY_HOST_ID: "host",
             RELAY_SESSION: O, RELAY_PROJECT: PROJ2, RELAY_URL: BASE2,
             TRANTOR_CONTRACT_OVERDUE_MS: "0" },
    });
    let b = ""; kid.stdout.on("data", d => (b += d));
    kid.on("close", () => resolve(b));
    kid.stdin.end(JSON.stringify({ session_id: "sup-stop-1", cwd: repo3, stop_hook_active: false }));
    setTimeout(() => { try { kid.kill("SIGKILL"); } catch {} }, 15000).unref?.();
  });
  let o = {}; try { o = JSON.parse(so || "{}"); } catch {}
  const blockedOnIt = o.decision === "block" && new RegExp(String(stranded.id)).test(o.reason || "");
  ok("the stop guard does NOT block on the superseded row", !blockedOnIt, (o.reason || so || "").slice(0, 220));
}

// ---- superseded by a later DIRECT reply: the morning case (#11047/#11048) --------------------
// This morning a row sat WAITING forever while its assignee demonstrably moved on: the assignee
// answered a NEWER re-dispatch and then acked the old rows "by reference" — direct replies that
// never mapped to the old row. The loose-reply fallback consumed the ack for an EVEN OLDER row, so
// the stranded row had no `re`, no loose reply, and no NEWER answered contract to the same peer
// (nothing newer was ever answered) — the newestAnswered rule above could not settle it. The direct
// reply itself was the signal: the assignee is alive and talking, so an old unanswered row past the
// abandon window is dead weight, not in flight.
console.log("\nA re-dispatch's direct reply settles the OLDER row it stranded (morning case):");
{
  const M = "deepseek:life";
  await post2("/register", { session: M, project: PROJ2, status: "working" });
  const older = await post2("/send", { from: O, to: M, project: PROJ2, text: "an older job, also superseded by the re-dispatch" });
  const stranded = await post2("/send", { from: O, to: M, project: PROJ2, text: "the row that must not strand" });
  // Age both rows past the abandon window while M stays demonstrably ALIVE (same heartbeat pattern
  // as the stranded drill above). The age gate matters: a FRESH out-of-order reply must never
  // settle a sibling row (drilled above), only a row past the in-flight window.
  for (let i = 0; i < 6; i++) { await sleep(550); await post2("/register", { session: M, project: PROJ2, status: "working" }); }
  const redispatch = await post2("/send", { from: O, to: M, project: PROJ2, text: "re-dispatch of the same work" });
  // The assignee's reply is an "ack by reference": a DIRECT reply that names the re-dispatch but
  // threads NO `re`, so the loose-reply fallback consumes it for the OLDEST open row (`older`) and
  // `stranded` is left with nothing — no re, no loose reply, and no newer answered contract.
  await post2("/send", { from: M, to: O, project: PROJ2, text: "✅ done on the re-dispatch (exit 0)" });
  await post2("/register", { session: M, project: PROJ2, status: "working" });

  const r = await ctr2(O);
  const open = Object.fromEntries((r.contracts || []).map(c => [c.id, c]));
  const sup = Object.fromEntries((r.supersededContracts || []).map(c => [c.id, c]));
  ok("the row the assignee's direct replies passed over is settled, not WAITING",
    sup[stranded.id]?.disposition === "superseded" && open[stranded.id] === undefined,
    JSON.stringify({ open: open[stranded.id], sup: sup[stranded.id] }).slice(0, 220));
  ok("…while the row that actually consumed the direct reply is answered",
    open[older.id]?.answered === true || sup[older.id]?.disposition === "superseded",
    JSON.stringify({ open: open[older.id], sup: sup[older.id] }).slice(0, 220));
  ok("the assignee is still reported ALIVE — the reply proves it, this is not abandonment",
    sup[stranded.id]?.assigneeOnline === true, `online=${sup[stranded.id]?.assigneeOnline}`);
  ok("a FRESH re-dispatch is untouched by the direct-reply rule (age gate protects in-flight work)",
    open[redispatch.id]?.disposition === "waiting", `${open[redispatch.id]?.disposition}`);
}

hub2.kill("SIGKILL");
hub.kill("SIGKILL");
console.log(`\n${fail === 0 ? "✅" : "❌"} contracts: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

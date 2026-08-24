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

hub.kill("SIGKILL");
console.log(`\n${fail === 0 ? "✅" : "❌"} contracts: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

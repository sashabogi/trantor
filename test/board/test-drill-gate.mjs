#!/usr/bin/env node
// The done gate (#6452, build doctrine rule 1): a card reaches done only when it carries a drill
// line — the `drill` field, a checklist item or a log note starting "Drill:", or the note riding
// the move itself. Everything else answers 409 and changes nothing on the card, whoever moves it.
// Drives the REAL hub over HTTP with the plain (unsigned, warn-mode) client, then restarts it to
// show the drill survives the JSON store the way `extra` fields do on Postgres.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "../drill-env.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PORT = 47893, BASE = `http://127.0.0.1:${PORT}`, PROJ = "drillproj";

function spawnHub(dir) {
  const hub = spawn("node", [join(ROOT, "hub.mjs")], {
    cwd: ROOT,
    env: { ...drillEnv(), HOME: dir, RELAY_DATA_DIR: dir, RELAY_PORT: String(PORT), PORT: String(PORT), RELAY_ONLINE_MS: "999999", TRANTOR_NO_UPDATE_CHECK: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  hub._stderr = "";
  hub.stderr.on("data", d => { hub._stderr += String(d); });
  return hub;
}
async function waitHub(hub) {
  for (let i = 0; i < 50; i++) {
    if (hub.exitCode !== null) throw new Error(`hub exited early: ${hub._stderr}`);
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {}
    await sleep(100);
  }
  throw new Error(`hub did not become healthy: ${hub._stderr}`);
}
async function stopHub(hub) {
  hub.kill();
  await Promise.race([new Promise(r => hub.once("close", r)), sleep(1500).then(() => hub.kill("SIGKILL"))]);
}
const post = async (p, b) => { const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, json: await r.json() }; };
const card = async (id, q = "") => (await (await fetch(`${BASE}/tasks?project=${PROJ}${q}`)).json()).tasks.find(t => t.id === id);
const create = async (b) => (await post("/task", { project: PROJ, by: "seat:drillproj", ...b })).json.task;

console.log("# trantor done gate: no drill line, no done");
const W = mkdtempSync(join(tmpdir(), "trantor-drill-gate-"));
let hub = spawnHub(W);
await waitHub(hub);
try {
  // ---- 1. the plain path: no drill anywhere -> 409, and the refused move touches nothing -------
  const bare = await create({ title: "wire the promoter", status: "doing" });
  ok("a card created without a drill carries none", bare.drill === undefined, JSON.stringify(bare.drill));
  const toTesting = await post("/task/update", { id: bare.id, status: "testing", by: "seat:drillproj", note: "tests: 12/12" });
  ok("testing is open to a drill-less card", toTesting.status === 200 && toTesting.json.task.status === "testing");
  const before = await card(bare.id);
  const refused = await post("/task/update", { id: bare.id, status: "done", by: "seat:drillproj", note: "all green, closing" });
  ok("done is refused with 409", refused.status === 409, `status=${refused.status}`);
  ok("the refusal names the missing drill line and how to add one",
    /drill/i.test(refused.json.error || "") && /Drill:/.test(refused.json.error || "") && refused.json.id === bare.id, refused.json.error);
  const after = await card(bare.id);
  ok("the card did not move", after.status === "testing", after.status);
  ok("the refused move left no history entry", (after.history || []).length === (before.history || []).length);
  ok("...and its note never landed on the log", (after.log || []).length === (before.log || []).length, JSON.stringify(after.log));

  // ---- 2. the orchestrator's own move is gated the same way -------------------------------------
  const orch = await post("/task/update", { id: bare.id, status: "done", by: "MacBook:drillproj", note: "closing from the orchestrator pane" });
  ok("the orchestrator's move to done is refused too when the card has no drill line", orch.status === 409, `status=${orch.status}`);

  // ---- 3. the move's own note starting "Drill:" is the drill line ------------------------------
  const drilled = await post("/task/update", { id: bare.id, status: "done", by: "MacBook:drillproj", note: "Drill: opened the board, clicked the card, saw the promoter row. PASS" });
  ok("a move whose note starts with Drill: reaches done", drilled.status === 200 && drilled.json.task.status === "done", JSON.stringify(drilled.json).slice(0, 160));
  ok("the drill note is on the log", (await card(bare.id)).log.some(e => /^Drill: opened the board/.test(e.text)));

  // ---- 4. the `drill` field: stored, capped at 300, shown in the slim projection ----------------
  const long = "open Settings, toggle the flag, " + "watch the badge turn green ".repeat(20);
  const withDrill = await create({ title: "ship the badge", status: "testing", drill: `  ${long}  ` });
  ok("the drill field is stored, whitespace collapsed, capped at 300", String(withDrill.drill ?? "").length === 300 && String(withDrill.drill ?? "").startsWith("open Settings, toggle the flag,"), `len=${withDrill.drill?.length}`);
  const slim = await card(withDrill.id, "&fields=slim");
  ok("the slim board projection keeps the drill", slim?.drill === withDrill.drill);
  const direct = await post("/task/update", { id: withDrill.id, status: "done", by: "MacBook:drillproj", note: "drill run, badge green" });
  ok("a card with a drill field reaches done", direct.status === 200 && direct.json.task.status === "done");

  // ---- 5. a checklist item starting "Drill:" counts -------------------------------------------
  const listed = await create({ title: "checklist drill", status: "testing", checklist: ["unit tests", "Drill: run trantor doctor and see the new row"] });
  const viaList = await post("/task/update", { id: listed.id, status: "done", by: "MacBook:drillproj" });
  ok("a checklist item starting with Drill: is a drill line", viaList.status === 200 && viaList.json.task.status === "done", JSON.stringify(viaList.json).slice(0, 120));

  // ---- 6. a note that merely mentions a drill is not a drill line; setting `drill` later fixes it
  const vague = await create({ title: "vague card", status: "testing" });
  await post("/task/update", { id: vague.id, by: "seat:drillproj", note: "we drilled it and it looked fine" });
  const stillNo = await post("/task/update", { id: vague.id, status: "done", by: "MacBook:drillproj" });
  ok("a note that only mentions a drill does not count", stillNo.status === 409, `status=${stillNo.status}`);
  const fixed = await post("/task/update", { id: vague.id, by: "MacBook:drillproj", drill: "open the card modal and read the drill row" });
  ok("`drill` can be set on an existing card without moving it", fixed.status === 200 && fixed.json.task.drill === "open the card modal and read the drill row" && fixed.json.task.status === "testing");
  const then = await post("/task/update", { id: vague.id, status: "done", by: "MacBook:drillproj" });
  ok("...after which done is open", then.status === 200 && then.json.task.status === "done");
  const same = await create({ title: "drill in the same request", status: "testing" });
  const oneShot = await post("/task/update", { id: same.id, status: "done", by: "MacBook:drillproj", drill: "click through the wizard and land on the summary" });
  ok("`drill` may ride the same request as the move to done", oneShot.status === 200 && oneShot.json.task.status === "done" && oneShot.json.task.drill);

  // ---- 7. what the gate deliberately leaves alone ----------------------------------------------
  const mirror = await create({ title: "mirrored card", status: "testing", source: "bridge" });
  const mirrored = await post("/task/update", { id: mirror.id, status: "done", by: "bridge", reassign: true });
  ok("a bridge mirror (source=bridge) replicates done without a drill line — the source hub already gated it", mirrored.status === 200 && mirrored.json.task.status === "done");
  const record = await create({ title: "abc1234 fix: a commit record", status: "done", source: "git" });
  ok("a card CREATED as done (git backfill, a record not a claim) is not gated", record.status === "done");
  const redo = await post("/task/update", { id: bare.id, status: "todo", by: "MacBook:drillproj" });
  const again = await post("/task/update", { id: bare.id, status: "done", by: "MacBook:drillproj" });
  ok("a reopened card whose drill line is on its log closes again", redo.status === 200 && again.status === 200 && again.json.task.status === "done");

  // ---- 8. restart: the drill survives the store ------------------------------------------------
  await sleep(1400);   // the JSON store persists on a 1s tick; give the last writes a chance to land
  await stopHub(hub);
  hub = spawnHub(W);
  await waitHub(hub);
  const backDrill = await card(withDrill.id);
  const backBare = await card(bare.id);
  ok("after a hub restart the drill field is still on the card", backDrill?.drill === withDrill.drill, String(backDrill?.drill).slice(0, 80));
  ok("...and the card closed on a Drill: note is still done", backBare?.status === "done");
  const stillGated = await create({ title: "post-restart bare card", status: "testing" });
  const postRestart = await post("/task/update", { id: stillGated.id, status: "done", by: "MacBook:drillproj" });
  ok("the gate holds after the restart", postRestart.status === 409, `status=${postRestart.status}`);
} catch (e) {
  fail++; console.log(`  FAIL  drill gate threw: ${e.stack || e}`);
} finally {
  await stopHub(hub);
  rmSync(W, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

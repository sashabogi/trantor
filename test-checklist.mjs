#!/usr/bin/env node
// Checklist contract test (#5624): acceptance items live on the card, toggle by index, refuse a
// stale index, replace wholesale via /task/update, and survive a hub restart (they ride `extra`).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function spawnHub(port, dir) {
  const hub = spawn("node", [join(ROOT, "hub.mjs")], {
    cwd: ROOT,
    env: { ...process.env, HOME: dir, RELAY_DATA_DIR: dir, RELAY_PORT: String(port), PORT: String(port), TRANTOR_NO_UPDATE_CHECK: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  hub._stderr = "";
  hub.stderr.on("data", d => { hub._stderr += String(d); });
  return hub;
}
async function waitHub(base, hub) {
  for (let i = 0; i < 50; i++) {
    if (hub.exitCode !== null) throw new Error(`hub exited early: ${hub._stderr}`);
    try { const r = await fetch(`${base}/health`); if (r.ok) return; } catch {}
    await sleep(100);
  }
  throw new Error(`hub did not become healthy: ${hub._stderr}`);
}
async function stopHub(hub) {
  hub.kill();
  await Promise.race([new Promise(r => hub.once("close", r)), sleep(1500).then(() => hub.kill("SIGKILL"))]);
}
const post = (base, path, bodyObj) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bodyObj) });

console.log("# trantor checklist tests");
const W = mkdtempSync(join(tmpdir(), "trantor-checklist-"));
const PORT = 47871, BASE = `http://127.0.0.1:${PORT}`;
let hub = spawnHub(PORT, W);
try {
  await waitHub(BASE, hub);

  // create with plain-string items — they become {text, done:false}
  let r = await post(BASE, "/task", { project: "clproj", title: "the checklisted card", by: "t",
    checklist: ["banner counts down", "expiry fires handoff_now", "divider recorded"] });
  const t = (await r.json()).task;
  ok("create seeds checklist from strings", t.checklist?.length === 3 && t.checklist.every(c => c.done === false && c.text));

  // toggle by index
  r = await post(BASE, "/task/checklist-toggle", { id: t.id, index: 1, done: true });
  const t2 = (await r.json()).task;
  ok("toggle marks exactly the indexed item", t2.checklist[1].done === true && !t2.checklist[0].done && !t2.checklist[2].done);

  // stale/bad index refuses loudly
  r = await post(BASE, "/task/checklist-toggle", { id: t.id, index: 9, done: true });
  ok("out-of-range index is a 400, never a silent wrong toggle", r.status === 400);
  r = await post(BASE, "/task/checklist-toggle", { id: 999999, index: 0, done: true });
  ok("unknown card is a 404", r.status === 404);

  // wholesale replace via /task/update; oversize input is capped
  r = await post(BASE, "/task/update", { id: t.id, checklist: Array.from({ length: 30 }, (_, i) => `item ${i}`) });
  const t3 = (await r.json()).task;
  ok("update replaces the checklist and caps at 20 items", t3.checklist?.length === 20 && t3.checklist[0].text === "item 0" && !t3.checklist[0].done);

  // a card without a checklist stays without one (empty replace clears)
  r = await post(BASE, "/task/update", { id: t.id, checklist: [] });
  const t4 = (await r.json()).task;
  ok("empty replace clears the checklist entirely", t4.checklist === undefined);

  // survives a hub restart (rides `extra`)
  await post(BASE, "/task/update", { id: t.id, checklist: ["persisted item"] });
  await post(BASE, "/task/checklist-toggle", { id: t.id, index: 0, done: true });
  await sleep(1200);   // let the dirty flush land before the restart
  await stopHub(hub);
  hub = spawnHub(PORT, W);
  await waitHub(BASE, hub);
  const tasks = (await (await fetch(`${BASE}/tasks?project=clproj`)).json()).tasks || [];
  const back = tasks.find(x => x.id === t.id);
  ok("checklist survives a hub restart, ticks included", back?.checklist?.length === 1 && back.checklist[0].done === true,
    JSON.stringify(back?.checklist));
} catch (e) {
  ok("suite ran", false, String(e?.stack || e).slice(0, 300));
} finally {
  await stopHub(hub);
  rmSync(W, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

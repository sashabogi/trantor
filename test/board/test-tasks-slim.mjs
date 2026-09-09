#!/usr/bin/env node
// #6983 fixes 2+3: the /tasks read has to be SMALL.
//
// On trantor /tasks had grown to 1.55MB across 958 cards — 625-961ms against a 1500ms budget, and
// past execSync's 1MB pipe — so a board read intermittently rendered as "hub 0", i.e. a dead hub,
// when the hub was 200 OK and merely slow. The weight was never the cards, it was what hangs off
// them: log 56.3%, history 11.8%, checklist 4.4% of the payload.
//
// What this pins:
//   1. `fields=slim` drops exactly those three and keeps every column a reader renders.
//   2. It is materially smaller — not smaller by a rounding error.
//   3. `card=<id>` re-attaches the ONE card the caller opened, in full, and ONLY that one.
//   4. The default read is UNCHANGED, so the fix cannot break an old client.
//   5. logCount preserves the ·N a board shows, so slimming costs a reader nothing visible.
//
// Written to FAIL if the projection is reverted: each assertion names a field the bug shipped.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

function spawnHub(port, dir) {
  const hub = spawn("node", [join(ROOT, "hub.mjs")], {
    cwd: ROOT,
    env: {
      ...drillEnv(),
      HOME: dir,
      RELAY_DATA_DIR: dir,
      RELAY_PORT: String(port),
      PORT: String(port),
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
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await sleep(100);
  }
  throw new Error(`hub did not become healthy: ${hub._stderr}`);
}

console.log("# /tasks slim projection (#6983)");

const dir = mkdtempSync(join(tmpdir(), "trantor-slim-"));
const port = 47899;
const base = `http://127.0.0.1:${port}`;
mkdirSync(dir, { recursive: true });

// A board shaped like the real one: many cards, each carrying the three heavy fields. The note text
// is what actually blew the budget, so the fixture makes it the dominant cost here too.
const NOTE = "x".repeat(400);
const tasks = [];
for (let id = 1; id <= 200; id++) {
  tasks.push({
    id,
    project: "slim",
    title: `card ${id} about the handoff seam`,
    status: id % 3 === 0 ? "done" : "todo",
    assignee: "claude:slim",
    difficulty: "medium",
    deps: id > 1 ? [id - 1] : [],
    by: "fixture",
    ts: id,
    updated: id,
    log: Array.from({ length: 8 }, (_, n) => ({ by: "claude:slim", ts: id, text: `${NOTE}${n}` })),
    history: Array.from({ length: 6 }, (_, n) => ({ to: "todo", by: "fixture", ts: id + n })),
    checklist: Array.from({ length: 5 }, (_, n) => ({ text: `${NOTE}${n}`, done: false })),
  });
}
writeFileSync(join(dir, "bus.json"), JSON.stringify({ tasks, taskSeq: 200, events: [] }));

const hub = spawnHub(port, dir);
const get = (p) => fetch(base + p).then(async r => ({ status: r.status, body: await r.text() }));

try {
  await waitHub(base, hub);

  const full = await get("/tasks?project=slim");
  const slim = await get("/tasks?project=slim&fields=slim");
  const one = await get("/tasks?project=slim&fields=slim&card=7");

  const fullJson = JSON.parse(full.body), slimJson = JSON.parse(slim.body), oneJson = JSON.parse(one.body);
  const fullCards = fullJson.tasks, slimCards = slimJson.tasks, oneCards = oneJson.tasks;

  // 4. The default read is untouched — the compatibility floor for every existing client.
  ok("default /tasks still returns full cards", fullCards.every(t => Array.isArray(t.log) && t.log.length === 8),
    `first card log=${JSON.stringify(fullCards[0]?.log?.length)}`);
  ok("default /tasks keeps history and checklist", fullCards.every(t => t.history && t.checklist));
  ok("default /tasks is NOT marked slim", fullJson.fields === undefined, `got fields=${fullJson.fields}`);

  // 1. The projection drops exactly the three heavy fields, and nothing else.
  ok("slim returns every card", slimCards.length === fullCards.length, `${slimCards.length} vs ${fullCards.length}`);
  ok("slim drops log", slimCards.every(t => t.log === undefined));
  ok("slim drops history", slimCards.every(t => t.history === undefined));
  ok("slim drops checklist", slimCards.every(t => t.checklist === undefined));
  ok("slim echoes the projection back", slimJson.fields === "slim", `got ${slimJson.fields}`);

  // Every column a board or a card header renders must survive, or slimming is a regression.
  for (const f of ["id", "title", "status", "assignee", "difficulty", "deps", "updated", "ts", "project"]) {
    ok(`slim keeps ${f}`, slimCards.every(t => t[f] !== undefined), `missing on #${slimCards.find(t => t[f] === undefined)?.id}`);
  }

  // 5. The ·N a reader sees is preserved without the note text behind it.
  ok("slim carries logCount instead of the log", slimCards.every(t => t.logCount === 8),
    `got ${slimCards[0]?.logCount}`);

  // 2. Materially smaller. A projection that saves 10% would not have moved the cliff.
  const ratio = slim.body.length / full.body.length;
  ok("slim is under a third of full", ratio < 0.33,
    `full=${full.body.length} slim=${slim.body.length} ratio=${(ratio * 100).toFixed(1)}%`);
  console.log(`        full=${full.body.length}B slim=${slim.body.length}B (${(ratio * 100).toFixed(1)}% of full)`);

  // 3. card=<id> re-attaches exactly one card, in full — this is the read every seat makes at the
  // start of every card, and it used to cost the whole board.
  const opened = oneCards.find(t => t.id === 7);
  ok("card=<id> returns that card with its full log", Array.isArray(opened?.log) && opened.log.length === 8,
    `got ${JSON.stringify(opened?.log?.length)}`);
  ok("card=<id> returns that card's checklist", Array.isArray(opened?.checklist) && opened.checklist.length === 5);
  ok("card=<id> leaves every OTHER card slim", oneCards.filter(t => t.id !== 7).every(t => t.log === undefined),
    `${oneCards.filter(t => t.id !== 7 && t.log !== undefined).length} other cards came back full`);
  ok("card=<id> still costs far less than the board", one.body.length < full.body.length * 0.4,
    `one=${one.body.length} full=${full.body.length}`);

  // Deps and the related-cards scan read off the index, so titles of OTHER cards must be there.
  ok("card=<id> keeps other cards' titles (deps + related need them)",
    oneCards.filter(t => t.id !== 7).every(t => String(t.title ?? "").length > 0));

  // A card id that is not on the board must not blow up or silently full-fatten the read.
  const missing = JSON.parse((await get("/tasks?project=slim&fields=slim&card=99999")).body);
  ok("card=<id> for an absent card stays slim", missing.tasks.every(t => t.log === undefined) && missing.tasks.length === 200);

  // A non-numeric card param is a client bug, not a reason to serve 1.55MB.
  const junk = JSON.parse((await get("/tasks?project=slim&fields=slim&card=abc")).body);
  ok("card=<non-numeric> stays slim", junk.tasks.every(t => t.log === undefined));

  // An unknown projection is not a slim projection — fail closed to the documented full payload.
  const unknown = JSON.parse((await get("/tasks?project=slim&fields=tiny")).body);
  ok("unknown fields= falls back to full", unknown.tasks.every(t => Array.isArray(t.log)) && unknown.fields === undefined);
} finally {
  hub.kill();
  await Promise.race([new Promise(r => hub.once("close", r)), sleep(1500).then(() => hub.kill("SIGKILL"))]);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

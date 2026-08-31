#!/usr/bin/env node
// Board integrity (#5406): a card can never change hands silently. Proves the hub-side
// assignee-immutability guard in the /task/update path:
//   - same-assignee update is legal (no-op, no log)
//   - a silent third-party steal is REFUSED (409) and does not half-apply a status move
//   - a HANDOFF (the current assignee reassigning) is legal and lands on the card log
//   - an EXPLICIT reassign (reassign:true) is legal and lands on the card log
//   - a normal status move (no assignee in the payload) still works, unchanged
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
    env: {
      ...process.env,
      HOME: dir,
      RELAY_DATA_DIR: dir,
      RELAY_PORT: String(port),
      PORT: String(port),
      RELAY_REAP_INTERVAL_MS: "120",
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
    try { const r = await fetch(`${base}/health`); if (r.ok) return; } catch {}
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

// Unlike the shared client in other tests, this one surfaces the HTTP status so the
// test can distinguish a 409 refusal from a 200 ok without trusting the body shape.
function client(base) {
  return {
    post: (p, b) => fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(b),
    }).then(async r => ({ status: r.status, ...(await r.json()) })),
    get: (p) => fetch(base + p).then(r => r.json()),
  };
}

console.log("# board integrity (assignee immutability)");

const dir = mkdtempSync(join(tmpdir(), "trantor-board-integrity-"));
const port = 48060;
const base = `http://127.0.0.1:${port}`;

let hub = spawnHub(port, dir);
try {
  await waitHub(base, hub);
  const A = client(base);

  const created = await A.post("/task", {
    project: "board-int", title: "freeze me", status: "todo", assignee: "alice:board", by: "alice:board",
  });
  const id = created.task.id;
  ok("card created with assignee", created.task.assignee === "alice:board", created.task.assignee);

  // 1. same-assignee update is legal (a no-op on the assignee, status still moves)
  const same = await A.post("/task/update", { id, assignee: "alice:board", status: "doing", by: "alice:board" });
  ok("same-assignee update ok", same.status === 200 && same.task?.assignee === "alice:board" && same.task?.status === "doing",
    JSON.stringify(same));

  // 2. silent third-party steal is refused
  const steal = await A.post("/task/update", { id, assignee: "bob:board", by: "mallory:board" });
  ok("silent steal rejected (409)", steal.status === 409 && steal.error === "assignee is immutable",
    `status=${steal.status} error=${steal.error}`);
  const afterSteal = (await A.get(`/card?id=${id}`)).task;
  ok("assignee unchanged after refused steal", afterSteal.assignee === "alice:board", afterSteal.assignee);

  // 3. a refused steal must not half-apply a status move bundled in the same request
  const stealMove = await A.post("/task/update", { id, assignee: "bob:board", status: "done", by: "mallory:board" });
  ok("steal+status move rejected (409)", stealMove.status === 409, `status=${stealMove.status}`);
  const afterStealMove = (await A.get(`/card?id=${id}`)).task;
  ok("status not half-applied on refused steal", afterStealMove.status === "doing", afterStealMove.status);

  // 4. handoff — the CURRENT assignee reassigning to someone else — is legal
  const handoff = await A.post("/task/update", { id, assignee: "carol:board", by: "alice:board" });
  ok("handoff by current assignee ok", handoff.status === 200 && handoff.task?.assignee === "carol:board",
    `status=${handoff.status} assignee=${handoff.task?.assignee}`);

  // 5. explicit reassign by a third party (reassign:true) is legal
  const reassign = await A.post("/task/update", { id, assignee: "dave:board", by: "mallory:board", reassign: true });
  ok("explicit reassign ok", reassign.status === 200 && reassign.task?.assignee === "dave:board",
    `status=${reassign.status} assignee=${reassign.task?.assignee}`);

  // 6. the handover is part of the card's story — written to the log, not a silent overwrite
  const story = (await A.get(`/card?id=${id}`)).task;
  ok("handoff written to card log", story.log?.some(e => /reassigned alice:board → carol:board \(handoff\)/.test(e.text)),
    JSON.stringify(story.log));
  ok("explicit reassign written to card log", story.log?.some(e => /reassigned carol:board → dave:board \(explicit\)/.test(e.text)),
    JSON.stringify(story.log));

  // 7. regression: a normal status move with no assignee in the payload is untouched
  const move = await A.post("/task/update", { id, status: "testing", by: "mallory:board" });
  ok("status-only move still works", move.status === 200 && move.task?.status === "testing" && move.task?.assignee === "dave:board",
    `status=${move.status}`);
} catch (e) {
  fail++;
  console.log(`  FAIL  test threw\n        ${e?.stack || e}`);
} finally {
  if (hub?.exitCode === null) await stopHub(hub);
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);

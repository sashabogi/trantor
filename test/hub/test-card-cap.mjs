#!/usr/bin/env node
// #11142: the fleet-wide card cap evicts done/stale cards oldest-first and never an open one.
// Before the fix, 26 open trantor cards vanished when ibkr and crebral-health pushed the fleet past 2,000.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestHub } from "../lib/test-hub.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
};
const post = (base, path, body) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
const board = (base, project) => fetch(`${base}/tasks?project=${project}`).then(r => r.json()).then(j => j.tasks || j);

console.log("# trantor card-cap tests (#11142)");
const W = mkdtempSync(join(tmpdir(), "trantor-cardcap-"));
const hub = await startTestHub({ dir: W, env: { RELAY_AUTH: "off" } });
const BASE = hub.base;
try {
  const open = [];
  for (const status of ["todo", "doing", "testing", "blocked", "failed"]) {
    const r = await post(BASE, "/task", { project: "keepme", title: `old ${status} card`, by: "t", status });
    open.push({ id: r.id ?? r.task?.id, status });
  }
  const oldDone = await post(BASE, "/task", { project: "keepme", title: "old done card", by: "t", status: "done" });
  const oldDoneId = oldDone.id ?? oldDone.task?.id;

  // Push the fleet well past the 2,000 cap with another project's done cards.
  const N = 2100;
  for (let i = 0; i < N; i++) await post(BASE, "/task", { project: "noisy", title: `noise ${i}`, by: "t", status: "done" });

  const kept = await board(BASE, "keepme");
  const keptIds = new Set(kept.map(c => c.id));
  for (const c of open) ok(`the old ${c.status} card survives the cap`, keptIds.has(c.id), `missing #${c.id}`);
  ok("the old done card is the one evicted", !keptIds.has(oldDoneId), `#${oldDoneId} still present`);

  const noisy = await board(BASE, "noisy");
  ok("the fleet is trimmed below the cap", kept.length + noisy.length <= 2000, `total ${kept.length + noisy.length}`);
  ok("the newest done cards are kept", noisy.some(c => c.title === `noise ${N - 1}`));
} finally {
  hub.proc.kill();
  try { rmSync(W, { recursive: true, force: true }); } catch {}
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

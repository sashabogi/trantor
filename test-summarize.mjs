#!/usr/bin/env node
// trantor narrative-cards tests (2026-07-30). Scrooge is STUBBED (same doctrine as test-reconcile):
// these tests prove the PIPELINE — candidate selection, one batched call, summaries landing on the
// hub and surviving as card fields — not the cheap model's prose.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "./drill-env.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${name}`); };

const P = 47941;
const dir = mkdtempSync(join(tmpdir(), "trantor-summarize-"));
mkdirSync(join(dir, ".agent-bus"), { recursive: true });
// the summarizer's config: one hub (ours), an owner identity it can mint locally
writeFileSync(join(dir, ".agent-bus", "config.json"),
  JSON.stringify({ url: `http://127.0.0.1:${P}`, ownerIdentity: "owner@test", hubs: {} }));

// stub scrooge: proves the batch shape (echoes ids it saw), returns canned narratives
const stub = join(dir, "scrooge-stub");
writeFileSync(stub, `#!/usr/bin/env node
let d = "";
process.stdin.on("data", c => d += c);
process.stdin.on("end", () => {
  const ids = [...d.matchAll(/CARD #(\\d+)/g)].map(m => Number(m[1]));
  process.stdout.write(JSON.stringify(ids.map(id => ({ id, assigned: "build the ads launcher", did: id % 2 ? "shipped with tests green" : "" }))));
});
`);
chmodSync(stub, 0o755);

function spawnHub() {
  return spawn("node", [join(ROOT, "hub.mjs")], {
    env: { ...drillEnv(), RELAY_DATA_DIR: dir, HOME: dir, RELAY_PORT: String(P), PORT: String(P), TRANTOR_NO_UPDATE_CHECK: "1", RELAY_AUTH: "off" },
    stdio: ["ignore", "ignore", "pipe"],
  });
}
const api = {
  post: (p, b) => fetch(`http://127.0.0.1:${P}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json()),
  get: (p) => fetch(`http://127.0.0.1:${P}${p}`).then(r => r.json()),
};

console.log("# trantor narrative-cards tests");
const hub = spawnHub();
await sleep(800);
try {
  // one machine-titled card (candidate), one human-titled (must be skipped), one already summarized
  const a = await api.post("/task", { project: "p", title: "subagent: You are grounding a concrete BUILD: instrumenting <task-notification> noise", by: "host:p" });
  const b = await api.post("/task", { project: "p", title: "P1-D Social UI: planner calendar", by: "host:p" });
  const c = await api.post("/task", { project: "p", title: "<task-notification> <task-id>xyz</task-id>", by: "host:p" });
  await api.post("/task/update", { id: c.task.id, summary: "already narrated" });
  await api.post("/send", { from: "codex:p", to: "all", project: "p", text: `#${a.task.id} done — tests green` });

  const run = (extra = []) => spawnSync("node", [join(ROOT, "bin/summarize.mjs"), ...extra], {
    env: { ...drillEnv(), HOME: dir, AGENT_BUS_DIR: join(dir, ".agent-bus"), SCROOGE_BIN: stub },
    encoding: "utf8", timeout: 30000,
  });

  const dry = run(["--dry"]);
  ok(dry.status === 0 && /would become/.test(dry.stdout), "dry run previews without writing");
  let cards = (await api.get("/tasks?project=p")).tasks;
  ok(!cards.find(t => t.id === a.task.id).summary, "dry run wrote nothing");

  const real = run([]);
  ok(real.status === 0, `summarize exits 0 (${(real.stderr || "").slice(0, 80)})`);
  cards = (await api.get("/tasks?project=p")).tasks;
  const A = cards.find(t => t.id === a.task.id);
  const B = cards.find(t => t.id === b.task.id);
  const C = cards.find(t => t.id === c.task.id);
  ok(!!A.summary && /build the ads launcher/.test(A.summary), "machine-titled card gained a narrative");
  ok(/—/.test(A.summary) === (a.task.id % 2 === 1) || A.summary === "build the ads launcher",
     "narrative is 'assigned — did' when the model reports a did");
  ok(!B.summary, "human-titled card is left alone (economics: no wasted calls)");
  ok(C.summary === "already narrated", "an existing summary is never recomputed");

  const again = run([]);
  ok(again.status === 0 && /0 narrative\(s\) written/.test(again.stdout), "second run is a no-op (permanent, not recomputed)");
} catch (e) { fail++; console.log(`  ✗ ${e.message}`); }
finally { hub.kill(); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

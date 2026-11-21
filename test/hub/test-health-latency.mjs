#!/usr/bin/env node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestHub } from "../lib/test-hub.mjs";

const dir = mkdtempSync(join(tmpdir(), "trantor-health-latency-"));
mkdirSync(join(dir, ".agent-bus"), { recursive: true });
const now = Date.now();
const messages = Array.from({ length: 5000 }, (_, i) => ({
  id: i + 1, ts: now - (5000 - i) * 1000, from_session: `seat-${i % 24}:trantor`,
  to_session: i % 5 === 0 ? "trantor-duty" : "all", text: `message ${i} ${"representative relay payload ".repeat(12)}`,
  project: "trantor", refs: [], re: null, wake: null, kind: null,
}));
const events = Array.from({ length: 50000 }, (_, i) => ({
  id: i + 1, ts: now - (50000 - i) * 100, type: "message", project: "trantor",
  by_session: `seat-${i % 24}:trantor`, task_id: null, payload: { msgId: i + 1, refs: [] },
}));
const tasks = Array.from({ length: 2000 }, (_, i) => ({
  id: i + 1, org_id: "default", project: "trantor", title: `task ${i}`, status: "doing",
  assignee: `seat-${i % 24}:trantor`, source: "session", difficulty: "", model: "", phase: "",
  cost_usd: null, deps: [], history: Array.from({ length: 20 }, (_, n) => ({ from: "todo", to: "doing", by: "fixture", ts: now - n })),
  created: now, updated: now, extra: { log: Array.from({ length: 20 }, (_, n) => ({ text: `task note ${n} ${"representative note ".repeat(6)}`, ts: now - n })) },
}));
const seedPath = join(dir, "pg-seed.json"), writesPath = join(dir, "pg-writes.log");
writeFileSync(seedPath, JSON.stringify({
  messages, events, tasks,
  peers: [{ session: "trantor-duty", last_seen: now, delivered_up_to: 0, project: "trantor", online: true }],
  kv: [{ key: "meta", value: { cardEventsBackfilled: true, eventSeq: events.length, taskSeq: tasks.length } }, { key: "seq", value: messages.length }],
}));

let hub;
try {
  const loader = new URL("./fake-pg-loader.mjs", import.meta.url).href;
  const nodeOptions = [process.env.NODE_OPTIONS, `--import=${loader}`].filter(Boolean).join(" ");
  hub = await startTestHub({ dir, env: {
    RELAY_STORE: "pg", RELAY_DATABASE_URL: "postgres://test", RELAY_TEST_PG_SEED: seedPath,
    RELAY_TEST_PG_WRITES: writesPath, NODE_OPTIONS: nodeOptions,
    RELAY_EVENT_CAP: "50000", RELAY_DUTY_SESSION: "trantor-duty", RELAY_PERSIST_RETRY_BASE_MS: "25",
  } });
  let sendNo = 0;
  const writer = (async () => {
    for (let i = 0; i < 100; i++) {
      const response = await fetch(`${hub.base}/send`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "perf-seat:trantor", to: "all", project: "trantor", text: `persist churn ${i}` }) });
      if (!response.ok) throw new Error(`/send returned ${response.status}`);
      sendNo++;
    }
  })();
  const samples = [];
  for (let i = 0; i < 50; i++) {
    const started = performance.now();
    const response = await fetch(`${hub.base}/health`);
    if (!response.ok) throw new Error(`/health returned ${response.status}`);
    await response.arrayBuffer();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  await writer;
  const persistDeadline = Date.now() + 3000;
  while ((!existsSync(writesPath) || !readFileSync(writesPath, "utf8").includes("saveDelta")) && Date.now() < persistDeadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (!existsSync(writesPath) || !readFileSync(writesPath, "utf8").includes("saveDelta")) throw new Error("health load did not reach PG saveDelta");
  const edit = await fetch(`${hub.base}/task/update`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, title: "task updated through copy-on-write", by: "latency-drill" }) });
  if (!edit.ok) throw new Error(`/task/update returned ${edit.status}`);
  const updateDeadline = Date.now() + 3000;
  while ((!existsSync(writesPath) || !readFileSync(writesPath, "utf8").includes("task-upsert")) && Date.now() < updateDeadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (!existsSync(writesPath) || !readFileSync(writesPath, "utf8").includes("task-upsert")) throw new Error("task edit was not persisted through PG saveDelta");
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  console.log(`/health p95 ${p95.toFixed(2)}ms; max ${samples.at(-1).toFixed(2)}ms; ${sendNo} writes; PG saveDelta and task upsert observed`);
  if (p95 >= 100) throw new Error(`/health p95 ${p95.toFixed(2)}ms is not under 100ms`);
} finally {
  if (hub) await hub.stop();
  rmSync(dir, { recursive: true, force: true });
}

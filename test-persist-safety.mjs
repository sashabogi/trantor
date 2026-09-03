#!/usr/bin/env node
// Regression drill for the 2026-09-02 data loss: a single NUL poisoned every Postgres delta for
// hours, while retries stayed invisible and a restart discarded the in-memory-only tail.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PgStore } from "./lib/store-pg.mjs";
import { createPersistHealth } from "./lib/persist-health.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;
const ok = (condition, name, detail = "") => {
  if (condition) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

function mockPool() {
  const log = [];
  const client = {
    query: async (sql, vals) => { log.push({ sql: String(sql), vals }); return { rows: [], rowCount: 1 }; },
    release: () => {},
    on: () => client,
    once: () => client,
  };
  return { log, pool: { query: client.query, connect: async () => client } };
}

const baseState = (overrides = {}) => ({
  messages: [], peers: {}, seq: 0, tasks: [], taskSeq: 0, projectMeta: {}, lessons: [],
  events: [], cardEventsBackfilled: false, aliases: {}, phaseMeta: {}, verifyGates: [],
  verifyGateSeq: 0, proposals: [], proposalSeq: 0, balances: { ts: 0, by: "", entries: [] },
  subagentCostReset: false, handoffLog: [], identities: {}, inviteTokens: {}, instances: {},
  focus: {}, orgPolicy: {}, contractReap: {}, eventSeq: 0, ...overrides,
});

function containsNul(value) {
  // SAFETY: Query parameters deliberately mix scalar columns, JSON strings, arrays and objects;
  // this recursive assertion decodes those test-only representations before checking their text.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof value === "string") {
    if (value.includes("\0")) return true;
    if (/^[\[{]/.test(value)) {
      try { return containsNul(JSON.parse(value)); } catch {}
    }
    return false;
  }
  if (Array.isArray(value)) return value.some(containsNul);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  return !!value && typeof value === "object" && Object.entries(value).some(([key, child]) => key.includes("\0") || containsNul(child));
}

console.log("store safety: every changed row is clean before PostgreSQL sees it");
{
  const { log, pool } = mockPool();
  const store = new PgStore({ pool });
  const poisoned = baseState({
    tasks: [{ id: 1, project: "p\0", title: "ta\0sk", status: "todo", assignee: "", source: "", difficulty: "", model: "", phase: "", costUsd: null, deps: [], history: [], log: [{ text: "no\0te" }], ts: 1, updated: 1 }],
    messages: [{ id: 1, ts: 1, from: "a", to: "b", project: "p", text: "me\0ssage", refs: [] }],
    events: [{ id: 1, ts: 1, type: "message", project: "p", by: "a", payload: { nested: { text: "ev\0ent" } } }],
    peers: { "a\0": { lastSeen: 1, status: "wo\0rking", project: "p" } },
    lessons: [{ text: "le\0sson" }],
  });
  await store.saveDelta("lo\0cal", baseState(), poisoned, { src: "hu\0b" });
  ok(!containsNul(log), "tasks, messages, events, peers and kv parameters contain no U+0000");
  const taskInsert = log.find(entry => entry.sql.includes("INSERT INTO tasks"));
  const messageInsert = log.find(entry => entry.sql.includes("INSERT INTO messages"));
  const eventInsert = log.find(entry => entry.sql.includes("INSERT INTO events"));
  const peerInsert = log.find(entry => entry.sql.includes("INSERT INTO peers"));
  ok(taskInsert?.vals[2] === "p" && taskInsert?.vals[3] === "task" && JSON.parse(taskInsert?.vals[15] || "{}").log[0].text === "note", "task columns and nested note are stripped");
  ok(messageInsert?.vals[6] === "message", "message text is stripped");
  ok(JSON.parse(eventInsert?.vals[7] || "{}").nested.text === "event", "nested event payload is stripped");
  ok(peerInsert?.vals[0] === "a" && peerInsert?.vals[4] === "working", "peer key and status are stripped");
}

console.log("persist state: exponential retry, one-minute logging and recovery");
{
  const tracker = createPersistHealth();
  const delays = [];
  let at = 0;
  for (let i = 0; i < 9; i += 1) {
    ok(tracker.canAttempt(at), `retry ${i + 1} is eligible at its scheduled time`);
    const result = tracker.failed(new Error(`db down ${i + 1}`), at);
    delays.push(result.delayMs);
    ok(!tracker.canAttempt(at + result.delayMs - 1), `retry ${i + 1} cannot run early`);
    at += result.delayMs;
  }
  ok(delays.join(",") === "1000,2000,4000,8000,16000,32000,60000,60000,60000", "retry delay doubles from 1s and caps at 60s", delays.join(","));

  const logs = createPersistHealth();
  const first = logs.failed(new Error("first\0 failure"), 10);
  const noisyRetry = logs.failed(new Error("second"), 1010);
  const minute = logs.failed(new Error("third"), 60010);
  const health = logs.view(65010);
  ok(first.shouldLog && !noisyRetry.shouldLog && minute.shouldLog, "failures log immediately, then at most once a minute");
  ok(!health.ok && health.failingSinceMs === 65000 && health.lastError === "third" && health.retries === 3, "/health state reports duration, last error and retry count");
  logs.succeeded();
  ok(JSON.stringify(logs.view(70000)) === JSON.stringify({ ok: true, failingSinceMs: 0, lastError: "", retries: 0 }), "a successful persist clears the failure state");
}

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(error => error ? reject(error) : resolve(port));
  });
});

const waitFor = async (check, timeoutMs = 5000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { const value = await check(); if (value) return value; } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  return null;
};

const children = new Set();
function startHub(port, dataDir, statePath, extraEnv = {}) {
  const child = spawn(process.execPath, [join(ROOT, "hub.mjs")], {
    cwd: ROOT,
    env: { ...process.env, HOME: dataDir, RELAY_PORT: String(port), RELAY_HOST: "127.0.0.1", RELAY_AUTH: "off", RELAY_STORE: "json", RELAY_DATA_DIR: dataDir, RELAY_STATE: statePath, ...extraEnv },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.errorText = "";
  child.stderr.on("data", chunk => { child.errorText += chunk; });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

const stopHub = child => new Promise(resolve => {
  if (!child || child.exitCode !== null) return resolve();
  child.once("exit", resolve);
  child.kill("SIGTERM");
});

const post = (base, path, payload) => fetch(base + path, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
}).then(async response => ({ status: response.status, ...(await response.json()) }));

const scratch = mkdtempSync(join(tmpdir(), "trantor-persist-safety-"));
try {
  console.log("hub boundary: NUL input is stripped and the send survives a restart");
  const statePath = join(scratch, "state.json");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let hub = startHub(port, scratch, statePath);
  const initialHealth = await waitFor(async () => {
    const response = await fetch(base + "/health");
    return response.ok ? response.json() : null;
  });
  ok(initialHealth?.persist?.ok === true, "healthy hub exposes persist.ok=true");

  const sent = await post(base, "/send", { from: "tester:p", to: "reader:p", text: "hello\0world" });
  const created = await post(base, "/task", { project: "p", title: "ta\0sk", note: "no\0te", by: "tester:p" });
  await post(base, "/task/update", { id: created.task.id, title: "up\0dated", note: "up\0note", by: "tester:p" });
  await post(base, "/lesson", { scope: "global", project: "p", text: "le\0sson", by: "tester:p" });
  ok(sent.status === 200 && created.status === 200, "NUL-bearing API writes are accepted after sanitization");
  const persisted = await waitFor(() => {
    if (!existsSync(statePath)) return null;
    const value = JSON.parse(readFileSync(statePath, "utf8"));
    return value.messages?.some(message => message.id === sent.id) ? value : null;
  });
  ok(!!persisted && !containsNul(persisted), "persisted JSON contains no U+0000 anywhere");
  await stopHub(hub);

  hub = startHub(port, scratch, statePath);
  await waitFor(async () => (await fetch(base + "/health")).ok);
  const recent = await fetch(base + "/recent?limit=20").then(response => response.json());
  const tasks = await fetch(base + "/tasks?project=p").then(response => response.json());
  ok(recent.messages?.some(message => message.id === sent.id && message.text === "helloworld"), "the sanitized NUL send survives hub restart");
  const restoredTask = tasks.tasks?.find(task => task.id === created.task.id);
  ok(restoredTask?.title === "updated" && restoredTask.log?.every(entry => !entry.text.includes("\0")), "task create/update title and notes are clean after restart");
  await stopHub(hub);

  console.log("hub health: an actual write failure becomes visible state");
  const badState = join(scratch, "state-is-a-directory");
  mkdirSync(badState);
  const badPort = await freePort();
  const badBase = `http://127.0.0.1:${badPort}`;
  hub = startHub(badPort, scratch, badState, { RELAY_PERSIST_RETRY_BASE_MS: "30", RELAY_PERSIST_RETRY_MAX_MS: "120", RELAY_PERSIST_LOG_INTERVAL_MS: "120" });
  await waitFor(async () => (await fetch(badBase + "/health")).ok);
  await post(badBase, "/send", { from: "tester:p", to: "reader:p", text: "cannot persist" });
  const failedHealth = await waitFor(async () => {
    const value = await fetch(badBase + "/health").then(response => response.json());
    return value.persist?.retries >= 2 ? value : null;
  });
  ok(failedHealth?.persist?.ok === false && failedHealth.persist.failingSinceMs >= 0 && /EISDIR|directory/i.test(failedHealth.persist.lastError), "write failure is standing /health state", JSON.stringify(failedHealth?.persist));
  ok((hub.errorText.match(/persist failing:/g) || []).length < failedHealth.persist.retries, "stderr is rate-limited instead of logging every retry");
  await stopHub(hub);

  console.log("restart guard: unhealthy persistence blocks restart unless forced");
  const mockBin = join(scratch, "mock-bin");
  const serviceLog = join(scratch, "systemctl.log");
  mkdirSync(mockBin);
  writeFileSync(join(mockBin, "curl"), "#!/bin/bash\nprintf '%s' \"$MOCK_HEALTH\"\n");
  writeFileSync(join(mockBin, "systemctl"), "#!/bin/bash\nprintf '%s\\n' \"$*\" >> \"$SYSTEMCTL_LOG\"\n");
  chmodSync(join(mockBin, "curl"), 0o755);
  chmodSync(join(mockBin, "systemctl"), 0o755);
  const guardEnv = { ...process.env, PATH: `${mockBin}:${process.env.PATH}`, SYSTEMCTL_LOG: serviceLog, MOCK_HEALTH: JSON.stringify({ ok: true, persist: { ok: false, failingSinceMs: 65000, lastError: "db rejected row", retries: 7 } }) };
  const refused = spawnSync("bash", [join(ROOT, "deploy/restart-hub.sh")], { cwd: ROOT, env: guardEnv, encoding: "utf8" });
  ok(refused.status === 1 && /failed for 1m 5s/.test(refused.stderr) && /losing every state change/.test(refused.stderr), "restart refusal names duration and state at risk", refused.stderr.trim());
  ok(!existsSync(serviceLog), "refused restart never invokes systemctl");
  const forced = spawnSync("bash", [join(ROOT, "deploy/restart-hub.sh"), "--force"], { cwd: ROOT, env: guardEnv, encoding: "utf8" });
  ok(forced.status === 0 && readFileSync(serviceLog, "utf8").trim() === "restart trantor-hub", "--force explicitly permits the restart");
} finally {
  for (const child of children) child.kill("SIGTERM");
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

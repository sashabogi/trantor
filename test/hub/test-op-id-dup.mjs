#!/usr/bin/env node
// #7755 drill: a write whose response is dropped after commit resolves to committed on query,
// a retry with the same op id does not duplicate the message or the move, a dropped refusal
// resolves to rejected, and a write the hub never saw reads "ambiguous" in those words.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect } from "node:net";
import { fileURLToPath } from "node:url";
import { drillEnv, scrubIdentityEnv } from "../drill-env.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); } };

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const p = server.address().port;
    server.close(e => e ? reject(e) : resolve(p));
  });
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const waitFor = async (check, ms = 8000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { try { const v = await check(); if (v) return v; } catch {} await sleep(30); }
  return null;
};

const post = (base, path, payload) => fetch(base + path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
}).then(async r => ({ ...(await r.json()), _status: r.status }));
const get = async (base, path) => fetch(base + path).then(async r => ({ ...(await r.json()), _status: r.status }));

const scratch = mkdtempSync(join(tmpdir(), "trantor-opid-"));
const children = new Set();
function startHub(port, dataDir, statePath) {
  const c = spawn(process.execPath, [join(ROOT, "hub.mjs")], {
    cwd: ROOT,
    env: drillEnv({ HOME: dataDir, RELAY_PORT: String(port), RELAY_HOST: "127.0.0.1",
      RELAY_AUTH: "off", RELAY_STORE: "json", RELAY_DATA_DIR: dataDir, RELAY_STATE: statePath }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.add(c);
  c.once("exit", () => children.delete(c));
  return c;
}

// A byte-level proxy in front of the hub. A POST whose bytes carry "opdrop" is forwarded and the
// hub's reply is swallowed, so the hub commits and the client times out: the dropped-response
// case, deterministically. A POST carrying "opeat" is never forwarded: the hub never saw it.
function startProxy(hubPort) {
  const proxy = createServer(client => {
    const up = connect(hubPort, "127.0.0.1");
    let head = "";
    let mode = "pass";
    client.on("data", chunk => {
      if (head.length < 4096) { head += chunk.toString("latin1"); }
      if (mode === "pass" && head.startsWith("POST ")) {
        if (head.includes("opeat")) mode = "eat";
        else if (head.includes("opdrop")) mode = "drop";
      }
      if (mode !== "eat") up.write(chunk);
    });
    up.on("data", chunk => { if (mode === "pass") client.write(chunk); });
    client.on("close", () => up.destroy());
    up.on("close", () => { if (mode === "pass") client.end(); });
    client.on("error", () => {});
    up.on("error", () => {});
  });
  return new Promise(r => proxy.listen(0, "127.0.0.1", () => r(proxy)));
}

let proxy = null;
try {
  const statePath = join(scratch, "state.json");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  startHub(port, scratch, statePath);
  const up = await waitFor(async () => fetch(`${base}/health`).then(r => r.ok ? r.json() : null));
  ok("scratch hub is up", !!up);

  // The client library enrolls against relayUrl(project) and keeps its keys under HOME. Pin both
  // to the scratch hub so the drill never touches the real hub or the runner's identity.
  scrubIdentityEnv();
  process.env.HOME = scratch;
  process.env.RELAY_URL = base;
  process.env.RELAY_SESSION = "drill-7755";
  const { signedPost, DEFAULT_TIMEOUT_MS, WRITE_TIMEOUT_MS } = await import(`${ROOT}/hooks/lib/api.mjs`);

  proxy = await startProxy(port);
  const via = `http://127.0.0.1:${proxy.address().port}`;

  console.log("\n# writes get their own timeout, reads keep theirs");
  {
    ok("DEFAULT_TIMEOUT_MS stays 1500 for reads", DEFAULT_TIMEOUT_MS === 1500, String(DEFAULT_TIMEOUT_MS));
    ok("WRITE_TIMEOUT_MS is at least 8000", WRITE_TIMEOUT_MS >= 8000, String(WRITE_TIMEOUT_MS));
  }

  console.log("\n# GET /_op answers unknown for a never-seen id");
  {
    const r = await get(base, "/_op?id=nosuchop");
    ok("unknown id returns status unknown", r._status === 200 && r.status === "unknown", JSON.stringify(r));
  }

  console.log("\n# /send with an op id: a retry returns the stored outcome, not a second message");
  {
    const r1 = await post(base, "/send", { from: "tester", to: "reader", text: "hello", _op: "send-op-1" });
    ok("first send commits", r1._status === 200 && r1.ok && r1.id > 0, `status=${r1._status} id=${r1.id}`);
    const r2 = await post(base, "/send", { from: "tester", to: "reader", text: "hello", _op: "send-op-1" });
    ok("retry with the same op id returns the same id", r2._status === 200 && r2.id === r1.id, `r1.id=${r1.id} r2.id=${r2.id}`);
    const msgs = await get(base, "/recent?limit=50");
    const stored = (msgs.messages || []).filter(m => m.from === "tester" && m.text === "hello");
    ok("only one message was stored", stored.length === 1, `got ${stored.length}`);
    const q = await get(base, "/_op?id=send-op-1");
    ok("GET /_op says committed", q._status === 200 && q.status === "committed" && q.code === 200, JSON.stringify(q));
    ok("the stored body carries the message id", q.body && q.body.id === r1.id, JSON.stringify(q.body));
    const stored1 = stored[0] || {};
    ok("the op id is not persisted on the message", !("_op" in stored1), JSON.stringify(stored1));
  }

  console.log("\n# /task, /task/update, /task/checklist-toggle: a retry does not duplicate");
  {
    const r1 = await post(base, "/task", { project: "p", title: "do a thing", by: "tester", _op: "task-op-2" });
    ok("card creation commits", r1._status === 200 && r1.task?.id > 0, `id=${r1.task?.id}`);
    const r2 = await post(base, "/task", { project: "p", title: "do a thing", by: "tester", _op: "task-op-2" });
    ok("retry returns the same card", r2._status === 200 && r2.task?.id === r1.task?.id, `r1=${r1.task?.id} r2=${r2.task?.id}`);
    const tasks = await get(base, "/tasks?project=p");
    ok("only one card was created", (tasks.tasks || []).filter(t => t.title === "do a thing").length === 1);

    const card = await post(base, "/task", { project: "p", title: "move me", by: "tester" });
    const m1 = await post(base, "/task/update", { id: card.task.id, status: "doing", note: "starting", by: "tester", _op: "update-op-3" });
    ok("move commits", m1._status === 200 && m1.task?.status === "doing", m1.task?.status);
    const m2 = await post(base, "/task/update", { id: card.task.id, status: "doing", note: "starting", by: "tester", _op: "update-op-3" });
    ok("retried move returns the same state", m2._status === 200 && m2.task?.status === "doing", m2.task?.status);
    const after = await get(base, `/card?id=${card.task.id}`);
    const moves = (after.task?.history || []).filter(h => h.to === "doing");
    ok("the move landed once in the card's history, not twice", moves.length === 1, `got ${moves.length}`);

    const cl = await post(base, "/task", { project: "p", title: "check me", by: "tester", checklist: ["item a", "item b"] });
    const t1 = await post(base, "/task/checklist-toggle", { id: cl.task.id, index: 0, done: true, _op: "toggle-op-4" });
    ok("toggle commits", t1._status === 200 && t1.task?.checklist?.[0]?.done === true, JSON.stringify(t1.task?.checklist));
    const t2 = await post(base, "/task/checklist-toggle", { id: cl.task.id, index: 0, done: true, _op: "toggle-op-4" });
    ok("retried toggle returns the same state", t2._status === 200 && t2.task?.checklist?.[0]?.done === true);
  }

  console.log("\n# a refused write is stored as rejected and replays its refusal");
  {
    const r1 = await post(base, "/task/update", { id: 999999, status: "doing", by: "tester", _op: "reject-op-5" });
    ok("the move is refused with 404", r1._status === 404, `status=${r1._status}`);
    const q = await get(base, "/_op?id=reject-op-5");
    ok("GET /_op says rejected with the code", q.status === "rejected" && q.code === 404, JSON.stringify(q));
    const r2 = await post(base, "/task/update", { id: 999999, status: "doing", by: "tester", _op: "reject-op-5" });
    ok("the retry replays the same refusal", r2._status === 404 && r2.error === r1.error, `status=${r2._status}`);
  }

  console.log("\n# dropped response after commit: the client resolves to committed, the retry does not duplicate");
  {
    const r = await signedPost(`${via}/send`, { from: "tester", to: "reader", text: "dropped reply", _op: "opdrop-6" }, { timeoutMs: 700 });
    ok("the write reports success, not failure", r.ok === true, JSON.stringify(r));
    ok("it says how it got there: resolved committed", r.resolved === "committed", JSON.stringify(r));
    ok("the body carries the message id", Number.isFinite(r.json?.id), JSON.stringify(r.json));
    const q = await get(base, "/_op?id=opdrop-6");
    ok("GET /_op agrees: committed", q.status === "committed" && q.body?.id === r.json?.id, JSON.stringify(q));
    const retry = await post(base, "/send", { from: "tester", to: "reader", text: "dropped reply", _op: "opdrop-6" });
    ok("a retry with the same op id returns the stored id", retry._status === 200 && retry.id === r.json?.id, JSON.stringify(retry));
    const msgs = await get(base, "/recent?limit=50");
    const stored = (msgs.messages || []).filter(m => m.from === "tester" && m.text === "dropped reply");
    ok("only one message was stored", stored.length === 1, `got ${stored.length}`);
  }

  console.log("\n# dropped response after a refusal: the client resolves to rejected");
  {
    const r = await signedPost(`${via}/task/update`, { id: 999999, status: "doing", by: "tester", _op: "opdrop-7" }, { timeoutMs: 700 });
    ok("the write reports failure", r.ok === false, JSON.stringify(r));
    ok("it is resolved rejected, not a timeout", r.resolved === "rejected" && !r.timedOut, JSON.stringify(r));
    ok("it carries the refusal's status", r.status === 404, String(r.status));
  }

  console.log("\n# a write the hub never saw reads ambiguous in those words");
  {
    const r = await signedPost(`${via}/send`, { from: "tester", to: "reader", text: "eaten", _op: "opeat-8" }, { timeoutMs: 700 });
    ok("the write reports failure", r.ok === false && r.timedOut === true, JSON.stringify(r));
    ok("the reason says ambiguous: timed out, outcome unknown", r.reason === "ambiguous: timed out, outcome unknown", r.reason);
    ok("it is flagged ambiguous, never resolved", r.ambiguous === true && !r.resolved, JSON.stringify(r));
    const msgs = await get(base, "/recent?limit=50");
    ok("nothing was stored", (msgs.messages || []).filter(m => m.text === "eaten").length === 0);
  }

  console.log("\n# a timed-out write without an op id keeps the old shape");
  {
    const r = await signedPost(`${via}/send`, { from: "tester", to: "reader", text: "opdrop legacy" }, { timeoutMs: 700 });
    ok("it is a plain timeout", r.ok === false && r.timedOut === true && !r.resolved && !r.ambiguous, JSON.stringify(r));
    ok("the reason names the budget", /timed out after 700ms/.test(r.reason || ""), r.reason);
  }
} finally {
  if (proxy) proxy.close();
  for (const c of children) c.kill("SIGTERM");
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { loadOrCreate } from "../../lib/identity.mjs";
import { sfetchJson } from "../../lib/signed-fetch.mjs";
import { performSwap, swapRuntime } from "../../bin/crew/swap.mjs";
import { unregisterSwapStage } from "../../bin/crew/stage.mjs";
import { scrubIdentityEnv } from "../drill-env.mjs";
import { startTestHub } from "../lib/test-hub.mjs";

scrubIdentityEnv();
const root = resolve(".agent-bus-out");
mkdirSync(root, { recursive: true });
const dir = mkdtempSync(join(root, "swap-readiness-"));
const project = "swap-readiness";
const session = `operator:${project}`;
Object.assign(process.env, { HOME: dir, AGENT_BUS_DIR: join(dir, ".agent-bus"), RELAY_PROJECT: project, RELAY_SESSION: session });
const hub = await startTestHub({ dir, env: { AGENT_BUS_DIR: process.env.AGENT_BUS_DIR, RELAY_AUTH: "enforce", RELAY_ENROLL: "tofu" } });
const owner = loadOrCreate("owner", "human");
async function post(identity, path, payload) {
  const response = await sfetchJson(hub.base + path, { identity, payload });
  return { status: response.status, body: await response.json() };
}
async function enroll(name, kind = "agent") {
  const identity = loadOrCreate(name, "agent");
  const invite = await post(owner, "/invite", { scopes: [{ project, role: "write" }] });
  assert.equal(invite.status, 200);
  assert.equal((await post(identity, "/enroll", { name, kind: "agent", token: invite.body.token })).status, 200);
  assert.equal((await post(identity, "/register", { session: name, project, kind })).status, 200);
  return identity;
}
let reads = 0, mode = "slow";
const proxy = createServer(async (req, res) => {
  if (req.url.startsWith("/peers")) {
    reads++;
    if (mode === "fail" || reads === 1) {
      if (reads === 1) await setTimeout(1800);
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "controlled slow roster" }));
      return;
    }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const response = await fetch(hub.base + req.url, {
    method: req.method, headers: req.headers,
    body: req.method === "GET" ? undefined : Buffer.concat(chunks),
  });
  res.writeHead(response.status, { "content-type": "application/json" });
  res.end(await response.text());
});
await new Promise(resolveListen => proxy.listen(0, "127.0.0.1", resolveListen));
const base = `http://127.0.0.1:${proxy.address().port}`;
process.env.RELAY_URL = base;
const ctx = { home: dir, project, hub: base, seatDir: join(dir, "seats"), statePath: join(dir, "windows"), env: { CREW_NO_PROC_KILL: "1" } };
const runtime = swapRuntime(ctx, {}, () => {});
const options = { from: "old", agent: "kimi" };
let stageSession;
const start = async (seat, stage) => {
  stageSession = `${stage.label}:${project}`;
  await enroll(stageSession);
  writeFileSync(`${stage.path}.ready`, JSON.stringify({ pid: process.pid, session: stageSession }));
};
let checks = 0;
function pass(message) { checks++; console.log(`PASS ${message}`); }
try {
  assert.equal((await post(owner, "/enroll", { name: "owner", kind: "human", scopes: [{ project: "*", role: "owner" }] })).status, 200);
  const operator = await enroll(session, "orch");
  const lifecycle = { ...runtime, validate: async () => ({ agent: "kimi" }), start, freeze() {}, resume() {}, stop() {},
    release: async () => unregisterSwapStage(base, project, stageSession) };
  const swapped = await performSwap(ctx, options, lifecycle);
  assert.equal(swapped.ok, true, swapped.reason);
  assert.ok(reads >= 2);
  pass("slow first roster response (>1500ms) retries and completes swap");
  const roster = async () => {
    const response = await sfetchJson(hub.base + "/peers", { identity: operator, method: "GET" });
    return (await response.json()).peers;
  };
  assert.ok(!(await roster()).some(p => p.session === stageSession));
  pass("released stage is removed from roster");

  const cancelled = await performSwap(ctx, options, { ...lifecycle, transfer() { throw new Error("controlled transfer failure"); } });
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.reason, /controlled transfer failure/);
  assert.ok(!(await roster()).some(p => p.session === stageSession));
  pass("production cancel removes the registered stage from roster");

  const otherSession = `other:${project}`;
  const other = await enroll(otherSession);
  assert.equal((await post(operator, "/unregister", { session: otherSession, project })).status, 403);
  assert.ok((await roster()).some(p => p.session === otherSession));
  assert.equal((await post(other, "/unregister", { session: otherSession, project })).status, 200);
  assert.equal((await post(other, "/unregister", { session: otherSession, project })).status, 200);
  pass("deregistration requires the session owner and is idempotent");

  mode = "fail";
  const failed = await performSwap(ctx, options, lifecycle);
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /status=503 reason=controlled slow roster timedOut=false|status=0 reason=timed out after \d+ms timedOut=true/);
  assert.ok(!(await roster()).some(p => p.session === stageSession));
  pass("deadline failure retains HTTP diagnostics and removes stage");
  console.log(`${checks} passed, 0 failed`);
} finally {
  proxy.closeAllConnections();
  await new Promise(resolveClose => proxy.close(resolveClose));
  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
}

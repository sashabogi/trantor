#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadOrCreate, signRequest } from "../../lib/identity.mjs";
import { swapRuntime } from "../../bin/crew/swap.mjs";
import { sessionContext } from "../../hooks/lib/api.mjs";
import { scrubIdentityEnv } from "../drill-env.mjs";
import { startTestHub } from "../lib/test-hub.mjs";

scrubIdentityEnv();
const output = resolve(".agent-bus-out");
mkdirSync(output, { recursive: true });
const dir = mkdtempSync(join(output, "transfer-auth-"));
const project = "swap-auth";
const orch = `operator:${project}`;
const from = `kimi:${project}`;
const to = `codex:${project}`;
Object.assign(process.env, { HOME: dir, AGENT_BUS_DIR: join(dir, ".agent-bus"), RELAY_HOST_ID: "operator", RELAY_PROJECT: project });
const hub = await startTestHub({ dir, env: { AGENT_BUS_DIR: process.env.AGENT_BUS_DIR, RELAY_AUTH: "enforce", RELAY_ENROLL: "tofu" } });
process.env.RELAY_URL = hub.base;

async function request(identity, path, payload) {
  const body = JSON.stringify(payload);
  const headers = identity ? signRequest(identity, { method: "POST", path, body }) : {};
  const response = await fetch(hub.base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  return { status: response.status, json: await response.json() };
}

async function enroll(owner, name, kind) {
  const identity = loadOrCreate(name, "agent");
  const invite = await request(owner, "/invite", { scopes: [{ project, role: "write" }], ttlSec: 3600 });
  assert.equal(invite.status, 200);
  const enrolled = await request(identity, "/enroll", { token: invite.json.token, name, kind: "agent" });
  assert.equal(enrolled.status, 200);
  const registered = await request(identity, "/register", { session: name, project, kind });
  assert.equal(registered.status, 200);
  return identity;
}

try {
  const owner = loadOrCreate("owner", "human");
  assert.equal((await request(owner, "/enroll", { name: "owner", kind: "human", scopes: [{ project: "*", role: "owner" }] })).status, 200);
  const orchestrator = await enroll(owner, orch, "orch");
  const seat = await enroll(owner, from, "agent");
  await enroll(owner, to, "agent");
  const sent = await request(orchestrator, "/send", { from: orch, to: from, project, text: "Implement the transfer drill", kind: "contract" });
  assert.equal(sent.status, 200);
  const payload = { from, to, project, readySession: to, pendingIds: [] };

  assert.equal((await request(null, "/contracts/transfer", payload)).status, 401);
  const refused = await request(seat, "/contracts/transfer", payload);
  assert.equal(refused.status, 403);
  assert.match(refused.json.error, /only the project's orchestrator or a human/);
  console.log("PASS unsigned request gets 401; enrolled write-scope seat gets 403");

  // Exercise swap's production signing path with the operator shell's default identity.
  assert.equal(sessionContext().session, orch);
  const runtime = swapRuntime({ hub: hub.base, project }, {}, () => {});
  const moved = await runtime.transfer(payload);
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.moved, [sent.json.id]);
  assert.equal(moved.messages[0].from, orch);
  assert.equal(moved.messages[0].to, to);
  console.log("PASS operator-shell swap signs as orchestrator and moves the original contract");

  const repeated = await request(orchestrator, "/contracts/transfer", payload);
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.json.moved, []);
  console.log("PASS orchestrator gets 200; transferred contract is no longer owed to the old seat");
} finally {
  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
}

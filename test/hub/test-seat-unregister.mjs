import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generate, signRequest } from "../../lib/identity.mjs";
import { down } from "../../bin/crew/state.mjs";
import { scrubIdentityEnv } from "../drill-env.mjs";
import { startTestHub } from "../lib/test-hub.mjs";

scrubIdentityEnv();
const out = resolve(".agent-bus-out");
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(out, "seat-unregister-"));
Object.assign(process.env, { HOME: dir, AGENT_BUS_DIR: join(dir, ".agent-bus"), RELAY_PROJECT: "fixture", RELAY_SESSION: "host:fixture" });
const hub = await startTestHub({ dir, env: { RELAY_AUTH: "enforce", RELAY_ENROLL: "tofu", AGENT_BUS_DIR: process.env.AGENT_BUS_DIR } });
process.env.RELAY_URL = hub.base;
const root = generate();
const request = async (identity, path, payload) => {
  const method = payload ? "POST" : "GET", body = payload ? JSON.stringify(payload) : undefined;
  const headers = { "content-type": "application/json" };
  if (identity) Object.assign(headers, signRequest(identity, { method, path, body }));
  const response = await fetch(hub.base + path, { method, headers, body });
  return { status: response.status, json: await response.json() };
};
const enroll = async (name, project, role, kind = "agent") => {
  const key = generate();
  const invite = await request(root, "/invite", { scopes: [{ project, role }], kind });
  assert.equal(invite.status, 200);
  assert.equal((await request(key, "/enroll", { name, kind, token: invite.json.token })).status, 200);
  return key;
};
const register = async (key, session, project = "fixture", kind = "agent") => {
  assert.equal((await request(key, "/register", { session, project, kind })).status, 200);
};
const roster = async () => (await request(root, "/peers")).json.peers.map(p => p.session);
const statePath = join(dir, "crew-windows.txt");
const ctx = { project: "fixture", statePath, hub: hub.base, env: { CREW_NO_PROC_KILL: "1" }, dry: false };
const closed = [];
const adapters = { herdr: { closePane: p => closed.push(p), closeWorkspace: p => closed.push(p) } };
let checks = 0;
const pass = label => { checks++; console.log(`PASS ${label}`); };
try {
  assert.equal((await request(root, "/enroll", { name: "root", kind: "human", scopes: [{ project: "*", role: "owner" }] })).status, 200);
  const owner = await enroll("host:fixture", "fixture", "owner", "human");
  // Production signing loads the host's enrolled key from the isolated key directory.
  mkdirSync(join(dir, ".agent-bus/keys"), { recursive: true });
  writeFileSync(join(dir, ".agent-bus/keys/host_fixture.json"), JSON.stringify({ ...owner, name: "host:fixture", kind: "human" }));
  const seat = await enroll("kimi:fixture", "fixture", "write");
  const sibling = await enroll("codex:fixture", "fixture", "write");
  await register(seat, "kimi:fixture"); await register(sibling, "codex:fixture");
  writeFileSync(statePath, "fixture\therdr\tkimi\tp1\nfixture\therdr\tcodex\tp2\nfixture\torch\t__orch__\tp0\n");
  assert.equal(await down(ctx, ["kimi"], adapters), 0);
  assert.ok(!(await roster()).includes("kimi:fixture"));
  assert.ok((await roster()).includes("codex:fixture"));
  assert.deepEqual(closed, ["p1"]);
  assert.match(readFileSync(statePath, "utf8"), /codex\tp2/);
  pass("stop removes local pane and hub agent row, preserving siblings and orchestrator");

  await register(seat, "kimi:fixture");
  rmSync(statePath);
  const lines = [], log = console.log;
  try { console.log = s => lines.push(s); assert.equal(await down(ctx, ["kimi"], adapters), 0); }
  finally { console.log = log; }
  assert.ok(!(await roster()).includes("kimi:fixture"));
  assert.ok(lines.some(s => /removed a stale seat row/.test(s)));
  assert.deepEqual(closed, ["p1"]);
  assert.equal(await down(ctx, ["kimi"], adapters), 0);
  pass("explicit stop removes ghost without a state file; retry is idempotent");

  await register(seat, "kimi:fixture");
  await down({ ...ctx, dry: true }, ["kimi"], adapters);
  assert.ok((await roster()).includes("kimi:fixture"));
  assert.equal(existsSync(statePath), false);
  pass("dry-run ghost stop leaves hub and local state untouched");

  const del = (key, session, project = "fixture") => request(key, "/unregister", { session, project });
  assert.equal((await del(null, "kimi:fixture")).status, 401);
  assert.equal((await del(sibling, "kimi:fixture")).status, 403);
  const approver = await enroll("phone:fixture", "fixture", "approver", "human");
  assert.equal((await del(approver, "kimi:fixture")).status, 403);
  const foreignOwner = await enroll("host:other", "other", "owner", "human");
  assert.equal((await del(foreignOwner, "kimi:fixture")).status, 403);
  assert.equal((await del(foreignOwner, "kimi:fixture", "other")).status, 403);
  await register(owner, "host:fixture", "fixture", "orch");
  assert.equal((await del(root, "host:fixture")).status, 403);
  await register(approver, "phone:fixture", "fixture", "human");
  assert.equal((await del(owner, "phone:fixture")).status, 403);
  assert.ok((await roster()).includes("kimi:fixture"));
  assert.equal((await del(seat, "kimi:fixture")).status, 200);
  assert.equal((await del(seat, "kimi:fixture")).status, 200);
  pass("same-project owner can remove another agent, not phone/orchestrator/cross-project peers; self-removal retained");

  const logs = [], error = console.error;
  try {
    console.error = s => logs.push(s);
    assert.equal(await down(ctx, ["ghost"], adapters, { unregister: async () => { throw new Error("hub unavailable"); } }), 1);
  } finally { console.error = error; }
  assert.ok(logs.some(s => /hub unavailable/.test(s)));
  pass("hub cleanup failure is reported with nonzero status");
  console.log(`${checks} passed, 0 failed`);
} finally { await hub.stop(); rmSync(dir, { recursive: true, force: true }); }

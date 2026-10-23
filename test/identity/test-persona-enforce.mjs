import { spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { drillEnv } from "../drill-env.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { allocatePersona } from "../../lib/persona.mjs";
import { loadOrCreate, signRequest } from "../../lib/identity.mjs";
import { ensureEnrolled } from "../../lib/enroll.mjs";
import { performSwap } from "../../bin/crew/swap.mjs";
import { startTestHub } from "../lib/test-hub.mjs";

mkdirSync(resolve(".agent-bus-out"), { recursive: true });
const home = mkdtempSync(resolve(".agent-bus-out/persona-enforce-"));
const bus = join(home, ".agent-bus");
const previous = { bus: process.env.AGENT_BUS_DIR, owner: process.env.RELAY_OWNER_IDENTITY };
process.env.AGENT_BUS_DIR = bus;
process.env.RELAY_OWNER_IDENTITY = "operator";
const hub = await startTestHub({ dir: join(home, "hub"), env: { RELAY_AUTH: "enforce", AGENT_BUS_DIR: bus } });
const project = "persona-drill";
const runners = [];
async function request(identity, path, payload) {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  const method = body ? "POST" : "GET";
  const response = await fetch(hub.base + path, { method, body, headers: { "content-type": "application/json", ...signRequest(identity, { method, path, body }) } });
  const json = await response.json();
  assert.equal(response.status, 200, JSON.stringify(json));
  return json;
}
const register = (identity, agent) => request(identity, "/register", { session: identity.name, project, llm: agent, kind: "agent" });
try {
  const owner = loadOrCreate("operator", "human");
  await request(owner, "/enroll", { name: owner.name, kind: "human", scopes: [{ project: "*", role: "owner" }] });
  const first = allocatePersona({ dir: bus, project, agent: "glm" });
  const second = allocatePersona({ dir: bus, project, agent: "glm" });
  const identities = [first, second].map(seat => loadOrCreate(`${seat.persona}:${project}`));
  for (const identity of identities) {
    assert.equal((await ensureEnrolled(hub.base, identity, project)).ok, true);
    await register(identity, "glm");
  }
  for (const seat of [first, second]) {
    const runner = spawn(process.execPath, ["bin/crew-runner.mjs", seat.persona, home], {
      env: drillEnv({ HOME: home, AGENT_BUS_DIR: bus, RELAY_URL: hub.base, RELAY_PROJECT: project,
        RELAY_OWNER_IDENTITY: "operator", CREW_PERSONA: seat.persona, CREW_AGENT: "glm", CREW_MODEL: "zai/test", TRANTOR_NO_UPDATE_CHECK: "1" }),
      stdio: "ignore",
    });
    runners.push(runner);
  }
  let booted = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const live = (await request(owner, `/peers?project=${project}`)).peers;
    booted = identities.every(id => live.some(peer => peer.session === id.name && peer.model === "zai/test"));
    if (booted) break;
    await setTimeout(100);
  }
  assert.ok(booted, "both actual glm runners register their persona independently");
  const peers = (await request(owner, `/peers?project=${project}`)).peers;
  assert.equal(peers.filter(peer => identities.some(id => id.name === peer.session)).length, 2);
  assert.notEqual(identities[0].pubkey, identities[1].pubkey);
  for (const identity of identities) assert.equal(peers.find(peer => peer.session === identity.name).pubkey, identity.pubkey);
  const legacy = loadOrCreate(`glm:${project}`);
  assert.equal(legacy.pubkey, identities[0].pubkey);
  assert.equal((await ensureEnrolled(hub.base, legacy, project)).reason, "already-enrolled");
  await register(legacy, "glm");
  const reviewer = loadOrCreate(`reviewer:${project}`);
  assert.equal((await ensureEnrolled(hub.base, reviewer, project)).ok, true);
  await register(reviewer, "glm");
  const sent = await request(owner, "/send", { from: owner.name, to: reviewer.name, project, text: "contract: preserve this history" });
  const ctx = { home, project, seatDir: join(bus, "seats"), statePath: join(bus, "crew-windows.txt") };
  const swapped = await performSwap(ctx, { from: "reviewer", agent: "kimi" }, {
    validate: async () => ({ agent: "kimi", model: "" }),
    start: async () => {}, ready: async () => reviewer.name,
    freeze: async () => {}, resume: async () => {}, stop: async () => { await request(owner, "/unregister", { session: reviewer.name, project }); }, cancel: async () => {},
    transfer: body => request(owner, "/contracts/transfer", body),
    release: async (stage, persona) => {
      assert.match(persona, /^kimi-\d+$/);
      const next = loadOrCreate(`${persona}:${project}`);
      assert.equal((await ensureEnrolled(hub.base, next, project)).ok, true);
      await register(next, stage.agent);
    },
  });
  assert.equal(swapped.ok, true, swapped.reason);
  assert.ok(swapped.moved.includes(sent.id));
  assert.equal(loadOrCreate(reviewer.name).pubkey, reviewer.pubkey);
  const roster = (await request(owner, `/peers?project=${project}`)).peers;
  assert.ok(!roster.some(peer => peer.session === reviewer.name));
  const after = roster.find(peer => peer.session === `${swapped.to}:${project}`);
  assert.notEqual(after.pubkey, reviewer.pubkey);
  const contracts = await request(owner, `/contracts?session=operator&project=${project}`);
  assert.equal(contracts.contracts.find(c => c.id === sent.id).to, after.session);
  assert.equal(after.llm, "kimi");
  console.log("enforce persona drill passed: distinct signed seats, swap gets its own signed name and retains contract ids, legacy enrollment retained");
} finally {
  for (const runner of runners) {
    runner.kill("SIGTERM");
    if (runner.exitCode === null && runner.signalCode === null) await new Promise(resolveExit => runner.once("exit", resolveExit));
  }
  await hub.stop();
  for (const [key, value] of [["AGENT_BUS_DIR", previous.bus], ["RELAY_OWNER_IDENTITY", previous.owner]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
}

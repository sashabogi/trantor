#!/usr/bin/env node
// Device registration is self-keyed and durable; pushes carry only readable transitions, with a
// matching background clear and no live APNs dependency in the tests.
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { startTestHub } from "../lib/test-hub.mjs";
import { generate, signRequest } from "../../lib/identity.mjs";
import { createAuthRuntime } from "../../hub/auth.mjs";
import { createNotifier } from "../../hub/notifier.mjs";
import { createEventRuntime } from "../../hub/events.mjs";
import { PgStore } from "../../lib/store-pg.mjs";

let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

async function signed(base, identity, method, path, bodyObject) {
  const body = bodyObject === undefined ? undefined : JSON.stringify(bodyObject);
  const headers = signRequest({ pubkey: identity.pubkey, privkey: identity.privkey }, { method, path, body });
  const response = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body });
  let json = {};
  try { json = await response.json(); } catch {}
  return { status: response.status, json };
}

console.log("# device registry and signer boundary");
const dir = mkdtempSync(join(tmpdir(), "trantor-device-push-"));
mkdirSync(join(dir, ".agent-bus"), { recursive: true });
const hubEnv = {
  AGENT_BUS_DIR: join(dir, ".agent-bus"), RELAY_HOST: "127.0.0.1", RELAY_AUTH: "enforce",
  RELAY_ENROLL: "tofu", RELAY_OVERSEER_TICK_MS: "600000", RELAY_PERSIST_RETRY_BASE_MS: "20",
};
let hub = await startTestHub({ dir, env: hubEnv });
const owner = generate(), reader = generate(), other = generate();
const tokenA = "a".repeat(64), tokenB = "b".repeat(64);
try {
  const own = await signed(hub.base, owner, "POST", "/enroll", { name: "operator", kind: "human", scopes: [{ project: "*", role: "owner" }] });
  const read = await signed(hub.base, reader, "POST", "/enroll", { name: "reader", kind: "human", scopes: [{ project: "projA", role: "read" }] });
  const otherEnrollment = await signed(hub.base, other, "POST", "/enroll", { name: "other", kind: "human", scopes: [{ project: "*", role: "owner" }] });
  ok("three identities enrolled", [own, read, otherEnrollment].every(r => r.status === 200));

  const registered = await signed(hub.base, owner, "POST", "/device/register", {
    apnsToken: tokenA, env: "sandbox", bundleId: "ai.trantor.companion", name: "owner-phone",
  });
  ok("owner registers a device", registered.status === 200 && registered.json.device?.pubkey === owner.pubkey, JSON.stringify(registered.json));
  const readerRegistered = await signed(hub.base, reader, "POST", "/device/register", {
    apnsToken: tokenB, env: "development", bundleId: "ai.trantor.companion", name: "reader-phone",
  });
  ok("a read-scoped signer registers and development maps to sandbox", readerRegistered.status === 200 && readerRegistered.json.device?.env === "sandbox", JSON.stringify(readerRegistered.json));

  const ownDevices = await signed(hub.base, owner, "GET", "/devices");
  ok("GET /devices returns only the caller's devices", ownDevices.status === 200 && ownDevices.json.devices?.length === 1 && ownDevices.json.devices[0].apns_token === tokenA);
  const spoofed = await signed(hub.base, owner, "POST", "/device/register", {
    pubkey: other.pubkey, apnsToken: "c".repeat(64), env: "production",
  });
  ok("a signer cannot register for another pubkey", spoofed.status === 403);
  const otherUnregister = await signed(hub.base, other, "POST", "/device/unregister", { apnsToken: tokenA });
  ok("a signer cannot unregister another's token", otherUnregister.status === 404);
  const stillThere = await signed(hub.base, owner, "GET", "/devices");
  ok("the refused unregister leaves the device intact", stillThere.json.devices?.length === 1);
  const badEnv = await signed(hub.base, owner, "POST", "/device/register", { apnsToken: "c".repeat(64), env: "qa" });
  ok("invalid APNs environment is refused", badEnv.status === 400);

  const updated = await signed(hub.base, reader, "POST", "/device/register", {
    apnsToken: tokenB, env: "sandbox", bundleId: "ai.trantor.companion", name: "reader-renamed", mutedProjects: ["projA"],
  });
  ok("re-register updates name and project mutes", updated.status === 200 && updated.json.device?.name === "reader-renamed" && updated.json.device?.muted_projects?.[0] === "projA");
  ok("re-register preserves creation and last-success timestamps", updated.json.device?.created === readerRegistered.json.device?.created && updated.json.device?.last_ok === 0);
  await sleep(80);
  const disk = JSON.parse(readFileSync(join(dir, "bus.json"), "utf8"));
  ok("JSON store persists the device collection", disk.devices?.length === 2 && disk.devices.some(d => d.apns_token === tokenB));
} finally {
  await hub.stop();
}

hub = await startTestHub({ dir, env: hubEnv });
try {
  const restored = await signed(hub.base, reader, "GET", "/devices");
  ok("JSON device registry survives restart", restored.json.devices?.length === 1 && restored.json.devices[0].name === "reader-renamed");
  const removed = await signed(hub.base, reader, "POST", "/device/unregister", { apnsToken: tokenB });
  ok("owner can unregister its own device", removed.status === 200 && removed.json.ok === true);
  const remaining = await signed(hub.base, owner, "GET", "/devices");
  ok("unregister removes only the matching device", remaining.json.devices?.length === 1 && remaining.json.devices[0].apns_token === tokenA);
} finally {
  await hub.stop();
}

console.log("# scoped APNs alerts, silent clears, and token lifecycle");
const identities = {
  owner: { pubkey: "owner", name: "operator", kind: "human", scopes: [{ project: "*", role: "owner" }] },
  reader: { pubkey: "reader", name: "reader", kind: "human", scopes: [{ project: "projA", role: "read" }] },
  muted: { pubkey: "muted", name: "muted", kind: "human", scopes: [{ project: "*", role: "owner" }] },
};
const state = {
  identities,
  aliases: {},
  peers: { "codex:projA": { kind: "agent" }, "operator": { kind: "human" } },
  devices: [
    { pubkey: "owner", apns_token: tokenA, env: "production", bundle_id: "ai.trantor.companion", name: "owner", created: 1, last_ok: 0, muted_projects: [] },
    { pubkey: "reader", apns_token: tokenB, env: "sandbox", bundle_id: "ai.trantor.companion", name: "reader", created: 1, last_ok: 0, muted_projects: [] },
    { pubkey: "muted", apns_token: "c".repeat(64), env: "production", bundle_id: "ai.trantor.companion", name: "muted", created: 1, last_ok: 0, muted_projects: ["projA"] },
  ],
};
let dirty = 0;
const authRuntime = createAuthRuntime({ state, markDirty: () => { dirty++; }, AUTH_MODE: "enforce", SUPERSEDE_GRACE_MS: 1000, LOOPBACK_BIND: true, ENROLL_MODE: "tofu" });
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const apnsKey = privateKey.export({ type: "pkcs8", format: "pem" });
const sent = [];
let responder = async () => ({ status: 200, body: "{}" });
let clock = 1_800_000_000_000;
const notifier = createNotifier({
  state, markDirty: () => { dirty++; }, canRead: authRuntime.canRead, now: () => clock,
  env: { APNS_KEY_ID: "KEY123", APNS_TEAM_ID: "TEAM123", APNS_PRIVATE_KEY: apnsKey },
  transport: async request => { sent.push(request); return responder(request); },
  log: () => {},
});
const payload = request => JSON.parse(request.body);
const take = () => sent.splice(0, sent.length);

await notifier.notify({ id: 1, type: "hold.opened", project: "projA", by: "codex:projA", holdId: 41, file: "hub/events.mjs" });
let batch = take();
ok("hold alert reaches readable devices and honours mute", batch.length === 2 && batch.some(r => r.path.endsWith(tokenA)) && batch.some(r => r.path.endsWith(tokenB)), `got ${batch.length}`);
const holdPayload = payload(batch[0]);
ok("HOLD category and kind/id/project payload", holdPayload.aps.category === "HOLD" && holdPayload.kind === "hold" && holdPayload.id === 41 && holdPayload.project === "projA", JSON.stringify(holdPayload));
ok("alert headers carry topic, type, priority and collapse id", batch[0].headers["apns-topic"] === "ai.trantor.companion" && batch[0].headers["apns-push-type"] === "alert" && batch[0].headers["apns-priority"] === "10" && batch[0].headers["apns-collapse-id"] === "hold-41");
ok("one push per eligible device, never a repeat", batch.length === 2);

await notifier.notify({ id: 2, type: "hold.opened", project: "projB", by: "codex:projB", holdId: 42, file: "x" });
batch = take();
ok("project scope excludes the projA-only device", batch.length === 2 && batch.some(r => r.path.endsWith(tokenA)) && !batch.some(r => r.path.endsWith(tokenB)));

await notifier.notify({ id: 3, type: "verify.gate.opened", project: "projA", by: "codex:projA", gateId: 51, claim: "prove it" });
batch = take();
ok("GATE alert carries its category and item", batch.length === 2 && payload(batch[0]).aps.category === "GATE" && payload(batch[0]).kind === "gate" && payload(batch[0]).id === 51);
await notifier.notify({ id: 4, type: "proposal.filed", project: "projA", by: "codex:projA", proposalId: 61, scope: "write files" });
batch = take();
ok("PROPOSAL alert carries its category and item", batch.length === 2 && payload(batch[0]).aps.category === "PROPOSAL" && payload(batch[0]).kind === "proposal" && payload(batch[0]).id === 61);

await notifier.notify({ id: 5, type: "message", project: "projA", by: "codex:projA", msgId: 71, toSession: "operator", text: "hello phone" });
batch = take();
ok("a direct message pushes only to the addressed identity", batch.length === 1 && batch[0].path.endsWith(tokenA) && payload(batch[0]).kind === "message");
await notifier.notify({ id: 6, type: "message", project: "projA", by: "codex:projA", msgId: 72, toSession: "reader", text: "hello reader" });
batch = take();
ok("a second identity has its own message mailbox", batch.length === 1 && batch[0].path.endsWith(tokenB));
await notifier.notify({ id: 7, type: "message", project: "projA", by: "codex:projA", msgId: 73, toSession: "all", text: "broadcast" });
ok("broadcast messages do not raise personal pushes", take().length === 0);

await notifier.notify({ id: 81, type: "presence.offline", project: "projA", by: "codex:projA" });
batch = take();
ok("crew-seat offline raises an alert", batch.length === 2 && payload(batch[0]).kind === "presence");
await notifier.notify({ id: 82, type: "presence.offline", project: "projA", by: "operator" });
ok("non-crew offline stays quiet", take().length === 0);

await notifier.notify({ id: 9, type: "hold.decided", project: "projA", by: "operator", holdId: 41, status: "go" });
batch = take();
const clearPayload = payload(batch[0]);
ok("decision sends a silent clear to the same devices", batch.length === 2 && clearPayload.aps["content-available"] === 1 && clearPayload.kind === "hold" && clearPayload.id === 41);
ok("silent clear has no alert and reuses the item collapse id", !clearPayload.aps.alert && !clearPayload.aps.category && batch[0].headers["apns-collapse-id"] === "hold-41" && batch[0].headers["apns-push-type"] === "background" && batch[0].headers["apns-priority"] === "5");
await notifier.notify({ id: 10, type: "verify.gate.resolved", project: "projA", by: "operator", gateId: 51 });
batch = take();
ok("gate resolution clears the gate item", batch.length === 2 && payload(batch[0]).kind === "gate" && payload(batch[0]).id === 51);
await notifier.notify({ id: 11, type: "proposal.decided", project: "projA", by: "operator", proposalId: 61 });
batch = take();
ok("proposal decision clears the proposal item", batch.length === 2 && payload(batch[0]).kind === "proposal" && payload(batch[0]).id === 61);
await notifier.notify({ id: 12, type: "hold.expired", project: "projA", by: "overseer", holdId: 41 });
batch = take();
ok("an expired hold clears its alert too", batch.length === 2 && payload(batch[0]).aps["content-available"] === 1 && payload(batch[0]).kind === "hold");
await notifier.notify({ id: 13, type: "proposal.withdrawn", project: "projA", by: "codex:projA", proposalId: 61 });
batch = take();
ok("a withdrawn proposal clears its alert too", batch.length === 2 && payload(batch[0]).kind === "proposal" && batch[0].headers["apns-collapse-id"] === "proposal-61");

const firstJwt = batch[0].headers.authorization;
await notifier.notify({ id: 12, type: "hold.opened", project: "projB", by: "codex:projB", holdId: 43 });
batch = take();
ok("APNs JWT is reused inside 50 minutes", batch[0].headers.authorization === firstJwt);
clock += 49 * 60 * 1000;
await notifier.notify({ id: 13, type: "hold.opened", project: "projB", by: "codex:projB", holdId: 44 });
batch = take();
ok("APNs JWT is still reused at 49 minutes", batch[0].headers.authorization === firstJwt);
clock += 60 * 1000;
await notifier.notify({ id: 14, type: "hold.opened", project: "projB", by: "codex:projB", holdId: 45 });
batch = take();
ok("APNs JWT rotates after 50 minutes", batch[0].headers.authorization !== firstJwt);
ok("successful pushes update last_ok", state.devices.find(d => d.apns_token === tokenA)?.last_ok > 0 && dirty > 0);

responder = async request => request.path.endsWith(tokenB) ? { status: 410, body: "" } : { status: 200, body: "{}" };
await notifier.notify({ id: 15, type: "hold.opened", project: "projA", by: "codex:projA", holdId: 46 });
take();
ok("APNs 410 drops the dead token", !state.devices.some(d => d.apns_token === tokenB) && state.devices.some(d => d.apns_token === tokenA));
responder = async request => request.path.endsWith("c".repeat(64)) ? { status: 400, body: JSON.stringify({ reason: "BadDeviceToken" }) } : { status: 200, body: "{}" };
await notifier.notify({ id: 16, type: "hold.opened", project: "projB", by: "codex:projB", holdId: 47 });
take();
ok("BadDeviceToken drops the dead token", !state.devices.some(d => d.pubkey === "muted"));

let disabledTransportCalls = 0;
const disabledLogs = [];
const disabled = createNotifier({
  state, markDirty: () => {}, canRead: authRuntime.canRead, env: {}, log: line => disabledLogs.push(line),
  transport: async () => { disabledTransportCalls++; return { status: 200, body: "{}" }; },
});
await disabled.notify({ id: 17, type: "hold.opened", project: "projA", by: "codex:projA", holdId: 48 });
ok("missing APNs configuration logs once and no-ops", disabledLogs.join("|") === "push disabled: no APNs key" && disabledTransportCalls === 0, disabledLogs.join("|"));

const eventState = { events: [], eventSeq: 0, peers: {} };
const runtime = createEventRuntime({
  state: eventState, markDirty: () => {}, AUTH_MODE: "enforce", ONLINE_MS: 1000, canon: value => value,
  notifier: { notify: () => { throw new Error("injected push failure"); } },
});
const appended = runtime.appendEvent("hold.opened", "projA", "codex:projA", { holdId: 49 });
ok("a synchronous push failure cannot break appendEvent", appended.id === 1 && eventState.events.length === 1);

console.log("# Postgres device collection round-trip");
const deviceRow = { pubkey: "owner", apns_token: tokenA, env: "production", bundle_id: "ai.trantor.companion", name: "owner", created: 7, last_ok: 8, muted_projects: ["projA"] };
const queryLog = [];
const client = {
  query: async (sql, values) => { queryLog.push({ sql: String(sql), values }); return { rows: [], rowCount: 1 }; },
  release: () => {}, on: () => client, once: () => client,
};
const pg = new PgStore({ pool: { query: client.query, connect: async () => client } });
await pg.saveDelta("local", { devices: [] }, { devices: [deviceRow] }, { src: "test" });
const deviceInsert = queryLog.find(row => row.sql.includes("INSERT INTO devices"));
ok("saveDelta upserts the device collection", !!deviceInsert && deviceInsert.values[2] === tokenA && JSON.parse(deviceInsert.values[8])[0] === "projA");
const rows = {
  tasks: [], peers: [], events: [], messages: [], identities: [], kv: [],
  devices: [{ org_id: "local", pubkey: "owner", apns_token: tokenA, env: "production", bundle_id: "ai.trantor.companion", name: "owner", created: 7, last_ok: 8, muted_projects: ["projA"] }],
};
const readClient = {
  query: async sql => {
    if (/COALESCE\(MAX\(id\),0\)/.test(String(sql))) return { rows: [{ max_id: 0 }] };
    return { rows: rows[String(sql).match(/FROM (\w+)/)?.[1] || ""] || [], rowCount: 0 };
  },
  release: () => {}, on: () => readClient, once: () => readClient,
};
const snapshot = await new PgStore({ pool: { query: readClient.query, connect: async () => readClient } }).loadSnapshot("local");
ok("loadSnapshot restores device fields", snapshot.devices.length === 1 && snapshot.devices[0].apns_token === tokenA && snapshot.devices[0].last_ok === 8 && snapshot.devices[0].muted_projects[0] === "projA");

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

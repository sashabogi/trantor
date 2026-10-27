#!/usr/bin/env node
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startTestHub } from "../lib/test-hub.mjs";
import { generate, signRequest } from "../../lib/identity.mjs";
import { createAuthRuntime } from "../../hub/auth.mjs";

const MiB = 1024 * 1024;
let checks = 0;
function equal(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  checks++;
  console.log(`  ✓ ${label}`);
}
const scratch = new URL("../../.agent-bus-out/12161-body-caps/", import.meta.url).pathname;
mkdirSync(scratch, { recursive: true });
async function boot(mode = "enforce") {
  const dir = mkdtempSync(join(scratch, "hub-"));
  const hub = await startTestHub({ dir, env: {
    RELAY_AUTH: mode, RELAY_ENROLL: "tofu", RELAY_PUBLIC_PORT: "0",
    RELAY_OVERSEER_TICK_MS: "600000",
  } });
  for (let i = 0; i < 100 && !hub.stderr.includes("public hub on"); i++) await sleep(10);
  const match = hub.stderr.match(/public hub on (http:\/\/127\.0\.0\.1:\d+)/);
  if (!match) { await hub.stop(); rmSync(dir, { recursive: true, force: true }); throw new Error(hub.stderr); }
  return { ...hub, publicBase: match[1], stop: async () => { await hub.stop(); rmSync(dir, { recursive: true, force: true }); } };
}
async function post(base, key, path, raw, extraHeaders = {}) {
  const headers = key ? signRequest(key, { method: "POST", path, body: raw }) : {};
  const res = await fetch(base + path, { method: "POST", headers: { ...headers, ...extraHeaders }, body: raw });
  return { status: res.status, body: await res.json() };
}
async function get(base, key, path) {
  const res = await fetch(base + path, { headers: signRequest(key, { method: "GET", path }) });
  return { status: res.status, body: await res.json() };
}
function chatBody(size) {
  const body = { project: "measure", session: "max-window", total: 400,
    turns: Array.from({ length: 400 }, (_, idx) => ({ idx, role: "assistant", blocks: [{ kind: "text", text: "", tool: null, tool_id: null }] })),
    meta: { working: false, model: "measurement", context: null } };
  const perTurn = Math.floor((size - Buffer.byteLength(JSON.stringify(body))) / 400);
  for (const turn of body.turns) turn.blocks[0].text = "x".repeat(perTurn);
  body.turns[399].blocks[0].text += "x".repeat(size - Buffer.byteLength(JSON.stringify(body)));
  return JSON.stringify(body);
}
function importBody(size, project = "measure") {
  // Match the real local state's row counts without copying its private contents into a test.
  const body = { project,
    tasks: Array.from({ length: 1954 }, (_, id) => ({ id: id + 1, title: "imported card", status: "todo" })),
    events: Array.from({ length: 16535 }, (_, id) => ({ id: id + 1, type: "created", taskId: 1 })),
    messages: Array.from({ length: 4920 }, (_, id) => ({ id: id + 1, text: "imported message" })) };
  body.messages[0].text += "x".repeat(size - Buffer.byteLength(JSON.stringify(body)));
  return JSON.stringify(body);
}

const hub = await boot();
try {
  const owner = generate(), writer = generate(), scoped = generate();
  equal((await post(hub.base, owner, "/enroll", JSON.stringify({ name: "owner", kind: "human" }))).status, 200, "owner enrolls");
  for (const [key, role] of [[writer, "write"], [scoped, "owner"]]) {
    const invite = await post(hub.base, owner, "/invite", JSON.stringify({ scopes: [{ project: "measure", role }], kind: "human" }));
    equal((await post(hub.base, key, "/enroll", JSON.stringify({ token: invite.body.token, name: role, kind: "human" }))).status, 200, `${role} scoped identity enrolls`);
  }
  {
    const raw = chatBody(16 * MiB);
    equal(Buffer.byteLength(raw), 16 * MiB, "400-turn chat fixture reaches the exact 16 MiB limit");
    const result = await post(hub.base, scoped, "/session/chat", raw);
    equal([result.status, result.body.have], [200, 400], "private scoped owner publishes max-size chat snapshot");
    const tail = await get(hub.base, owner, "/session/chat?project=measure&after=398");
    equal(tail.body.turns.map(t => t.idx), [399], "last of 400 long turns reaches the mirror");
    equal((await post(hub.base, owner, "/session/chat", raw + " ")).status, 413, "chat cap rejects one byte over budget");
  }
  {
    const raw = importBody(7719098);
    equal(Buffer.byteLength(raw), 7719098, "import matches the measured real-state import wire size");
    const result = await post(hub.base, owner, "/import", raw);
    equal([result.status, result.body.tasks, result.body.events, result.body.messages], [200, 1954, 16535, 4920], "large private signed import preserves all row counts");
    const card = await get(hub.base, owner, "/card?id=1954");
    equal(card.body.task.title, "imported card", "last imported card exists through the real route");
  }
  const large = importBody(5 * MiB, "other");
  equal((await post(hub.base, null, "/import", large)).status, 413, "unsigned private requests keep the 4 MiB cap");
  equal((await post(hub.base, writer, "/import", large)).status, 413, "a signed writer cannot obtain the owner read budget");
  equal((await post(hub.base, generate(), "/import", large)).status, 413, "an unknown signed key keeps the small cap");
  equal((await post(hub.base, owner, "/import", large, { "x-trantor-sig": "forged" })).status, 401, "a forged owner header cannot authorize a large body");
  equal((await post(hub.base, scoped, "/import", large)).status, 403, "large-body ownership is checked against the landing project");
  equal((await post(hub.publicBase, owner, "/import", large)).status, 404, "public listener never exposes import even to owners");
  equal((await post(hub.publicBase, owner, "/session/chat", large)).status, 404, "public listener never exposes chat publishing");
  equal((await post(hub.publicBase, owner, "/task/update", large)).status, 413, "public owner writes retain the 4 MiB cap");
  const handoff = { project: "measure", session: "measurement", trigger: "manual" };
  equal((await post(hub.base, owner, "/handoff", JSON.stringify(handoff))).body.allow, true, "normal handoff guard write works");
  const card = await post(hub.base, owner, "/task", JSON.stringify({ project: "measure", title: "long checklist", note: "x".repeat(2000), checklist: Array(20).fill("x".repeat(200)) }));
  equal(card.status, 200, "full-length card note and checklist fit the small cap");
  equal((await post(hub.base, owner, "/task/update", JSON.stringify({ id: card.body.task.id, note: "x".repeat(2000) }))).status, 200, "full-length card update fits the small cap");
} finally { await hub.stop(); }

for (const mode of ["off", "warn"]) {
  const hub = await boot(mode);
  try {
    const owner = generate();
    await post(hub.base, owner, "/enroll", JSON.stringify({ name: "owner", kind: "human" }));
    const raw = chatBody(5 * MiB);
    equal((await post(hub.base, owner, "/session/chat", raw, { "x-trantor-sig": "forged" })).status, 401, `${mode} cannot bypass large-body signature verification`);
    equal((await post(hub.base, owner, "/session/chat", raw)).status, 200, `${mode} accepts a genuinely signed owner body`);
  } finally { await hub.stop(); }
}

const key = generate();
const runtime = createAuthRuntime({ state: { identities: { [key.pubkey]: { scopes: [{ project: "*", role: "owner" }] } } }, markDirty() {}, AUTH_MODE: "enforce" });
const req = { headers: signRequest(key, { method: "POST", path: "/import", body: "" }) };
equal(runtime.ownerBodyCap(req, "/import"), 64 * MiB, "private import has the measured 64 MiB budget");
equal(runtime.bodyCap("/import"), 4 * MiB, "ordinary import budget stays small");
equal(runtime.ownerBodyCap(req, "/handoff"), 4 * MiB, "handoff has an explicit small budget");
equal(runtime.ownerBodyCap(req, "/task"), 4 * MiB, "card creation has an explicit small budget");
equal(runtime.ownerBodyCap(req, "/task/update"), 4 * MiB, "card updates have an explicit small budget");
equal(runtime.bodyCap("/session/prompt"), 16 * MiB, "phone photo upload retains its existing exception");
const stream = new EventEmitter();
stream.resume = () => {};
const wire = Buffer.from('{"text":"📷é"}');
const read = runtime.rawBody(stream, wire.length);
for (const byte of wire) stream.emit("data", Buffer.from([byte]));
stream.emit("end");
equal(await read, wire.toString(), "split UTF-8 bytes survive body reading for signature verification");
console.log(`request body limits: ${checks} checks passed`);

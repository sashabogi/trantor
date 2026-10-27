#!/usr/bin/env node
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startTestHub } from "../lib/test-hub.mjs";
import { generate, signRequest } from "../../lib/identity.mjs";
import { createPublicGate, publicClientIP } from "../../hub/public.mjs";

let checks = 0;
function equal(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  checks++;
}
async function request(base, key, method, path, data, ip = "192.0.2.1", extra = {}) {
  const body = data === undefined ? undefined : JSON.stringify(data);
  const headers = { "content-type": "application/json", "x-forwarded-for": ip, ...extra };
  if (key) Object.assign(headers, signRequest(key, { method, path, body }));
  const res = await fetch(base + path, { method, body, headers });
  return { status: res.status, json: await res.json(), retry: res.headers.get("retry-after") };
}
async function headersOnlyPost(base, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/session/prompt`, {
      method: "POST", headers: { "content-length": String(16 * 1024 * 1024), ...headers },
    }, res => {
      res.resume();
      res.on("end", () => { req.destroy(); resolve(res.statusCode); });
    });
    req.setTimeout(3000, () => req.destroy(new Error("public listener waited for the unsigned body")));
    req.on("error", reject);
    req.flushHeaders();
  });
}

const scratch = new URL("../../.agent-bus-out/", import.meta.url);
mkdirSync(scratch, { recursive: true });
async function boot(auth = "enforce", publicUrl = "https://phone.example") {
  const dir = mkdtempSync(join(scratch.pathname, "public-port-"));
  const hub = await startTestHub({ dir, env: {
    RELAY_HOST: "127.0.0.1", RELAY_AUTH: auth, RELAY_ENROLL: "tofu",
    RELAY_PUBLIC_PORT: "0", RELAY_PUBLIC_URL: publicUrl, RELAY_BOOTSTRAP_TOKEN: "private-bootstrap",
    RELAY_OVERSEER_TICK_MS: "600000",
  } });
  for (let i = 0; i < 100 && !hub.stderr.includes("public hub on"); i++) await sleep(10);
  const match = hub.stderr.match(/public hub on (http:\/\/127\.0\.0\.1:\d+)/);
  if (!match) { await hub.stop(); throw new Error(hub.stderr); }
  return { ...hub, publicBase: match[1], stop: async () => { await hub.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

const reqIP = (socket, xff) => ({ socket: { remoteAddress: socket }, headers: { "x-forwarded-for": xff } });
// the proxy appends the address it saw: the LAST entry is the real client, the first is caller-supplied
equal(publicClientIP(reqIP("127.0.0.1", "198.51.100.1, 198.51.100.2")), "198.51.100.2", "last XFF from loopback is the real client");
equal(publicClientIP(reqIP("127.0.0.1", "203.0.113.77, 198.51.100.2")), "198.51.100.2", "a spoofed leading XFF entry cannot pick the bucket");
equal(publicClientIP(reqIP("::ffff:127.0.0.1", "2001:0db8::1")), "2001:db8::1", "mapped loopback and canonical IPv6");
equal(publicClientIP(reqIP("::1", "::ffff:192.0.2.8")), "192.0.2.8", "mapped client shares IPv4 bucket");
equal(publicClientIP(reqIP("198.51.100.9", "192.0.2.9")), "198.51.100.9", "remote socket cannot spoof XFF");
equal(publicClientIP(reqIP("127.0.0.1", "192.0.2.9, invalid")), "127.0.0.1", "an invalid last XFF falls back to socket");

equal(publicClientIP(reqIP("127.0.0.1", "fe80::1%lo0")), "127.0.0.1", "scoped forwarded address cannot bypass limits");

let clock = 0;
const gate = createPublicGate({ now: () => clock });
function admission(ip) {
  const res = new EventEmitter();
  res.writeHead = code => { res.statusCode = code; };
  res.end = () => {};
  return gate.admit({ ...reqIP("127.0.0.1", ip), method: "GET" }, res, "/health");
}
try {
  for (let i = 0; i < 10000; i++) assert.ok(admission(`10.0.${i >> 8}.${i & 255}`));
  equal(admission("198.51.100.1"), false, "bucket capacity fails closed");
  clock = 60000;
  equal(admission("198.51.100.1"), true, "idle buckets pruned at capacity");
  for (let i = 1; i < 120; i++) assert.ok(admission("198.51.100.1"));
  equal(admission("198.51.100.1"), false, "120 per window");
  clock = 120000;
  equal(admission("198.51.100.1"), true, "window resets");
} finally { gate.close(); }

const hub = await boot();
const owner = generate();
const phone = generate();
const streams = [];
try {
  const pub = hub.publicBase;
  for (const base of [hub.base, pub]) {
    const health = await request(base, null, "GET", "/health");
    equal(health.status, 200, "health unsigned");
    equal(health.json.publicUrl, "https://phone.example", "health advertises public URL");
  }
  equal((await request(pub, generate(), "POST", "/enroll", { token: "private-bootstrap", kind: "human" })).status, 403, "bootstrap cannot mint public owner");
  equal((await request(pub, generate(), "POST", "/enroll", { token: "é".repeat(17) })).status, 403, "public invite skips bootstrap comparison");
  equal((await request(hub.base, owner, "POST", "/enroll", { name: "owner", kind: "human" })).status, 200, "private TOFU unchanged");
  equal((await request(pub, null, "GET", "/tasks")).status, 401, "unsigned public read refused");
  equal(await headersOnlyPost(pub), 401, "unsigned 16 MiB POST refused before any body bytes are sent");
  const completeHeaders = signRequest(phone, { method: "POST", path: "/session/prompt", body: "" });
  equal(await headersOnlyPost(pub, completeHeaders), 401, "unknown pubkey with all signature headers refused before body read");
  equal(await headersOnlyPost(pub, Object.fromEntries(Object.keys(completeHeaders).map(key => [key, "dummy"]))),
    401, "dummy signature headers cannot obtain a 16 MiB read");
  for (const header of ["x-trantor-pubkey", "x-trantor-sig", "x-trantor-ts", "x-trantor-nonce"]) {
    const incomplete = { ...completeHeaders };
    delete incomplete[header];
    equal(await headersOnlyPost(pub, incomplete), 401, `missing ${header} refused without reading a body`);
  }

  equal((await request(pub, null, "POST", "/enroll", {})).status, 401, "unsigned tokenless enrollment refused");
  equal((await request(pub, phone, "POST", "/enroll", { name: "phone", kind: "human" })).status, 403, "public TOFU refused");
  const invite = await request(hub.base, owner, "POST", "/invite", { scopes: [{ project: "demo", role: "approver" }], kind: "human" });
  equal(invite.status, 200, "owner private invite unchanged");
  equal((await request(pub, phone, "POST", "/enroll", { token: invite.json.token, name: "phone", kind: "human" })).status, 200, "signed invite enrolls new phone");
  const readOnly = generate();
  const readInvite = await request(hub.base, owner, "POST", "/invite", { scopes: [{ project: "demo", role: "read" }], kind: "human" });
  equal((await request(pub, readOnly, "POST", "/enroll", { token: readInvite.json.token, name: "reader", kind: "human" })).status,
    200, "read-only key enrolls through the exempt route");
  equal(await headersOnlyPost(pub, signRequest(readOnly, { method: "POST", path: "/session/prompt", body: "" })),
    401, "enrolled read-only key refused before body read");
  equal((await request(pub, generate(), "POST", "/enroll", { token: invite.json.token })).status, 403, "invite cannot be reused for a new key");
  equal((await request(pub, owner, "POST", "/enroll", {})).status, 403, "existing owner still needs token");
  for (const path of ["/projects", "/tasks?project=demo", "/session/chat?project=demo", "/crew/roster?project=demo"]) {
    equal((await request(pub, phone, "GET", path)).status, 200, `allowlisted ${path}`);
  }
  equal((await request(pub, phone, "GET", "/tasks?project=other")).status, 403, "project scope enforced");
  equal((await request(pub, phone, "POST", "/session/prompt", { project: "demo", text: "hello" })).status, 200, "allowlisted signed write");
  for (const [method, path] of [
    ["GET", "/"], ["GET", "/ui"], ["GET", "/unknown"], ["POST", "/invite"],
    ["POST", "/project/delete"], ["POST", "/import"], ["GET", "/policy"], ["POST", "/policy"],
    ["POST", "/sweep"], ["POST", "/reconcile"], ["POST", "/crew/roster"],
    ["POST", "/session/prompt/claim"], ["POST", "/session/prompt/ack"], ["GET", "/session/prompts"],
    ["GET", "/session/attachment"],
    ["POST", "/session/chat"], ["POST", "/health"], ["GET", "/enroll"], ["HEAD", "/tasks"],
    ["GET", "/tasks/"], ["GET", "/%74asks"],
  ]) {
    const headers = signRequest(owner, { method, path: `${path}?project=demo` });
    const res = await fetch(`${pub}${path}?project=demo`, { method, headers: { ...headers, "x-forwarded-for": "192.0.2.2" } });
    equal(res.status, 404, `owner denied ${method} ${path}`);
    await res.arrayBuffer();
  }
  equal((await request(pub, null, "POST", "/invite", {})).status, 404, "unknown route hides before auth");
  const signed = signRequest(phone, { method: "GET", path: "/tasks?project=demo" });
  let res = await fetch(`${hub.base}/tasks?project=demo`, { headers: signed });
  equal(res.status, 200, "first signature private"); await res.arrayBuffer();
  res = await fetch(`${pub}/tasks?project=demo`, { headers: signed });
  equal(res.status, 401, "nonce replay blocked across listeners"); await res.arrayBuffer();
  equal((await request(hub.base, null, "GET", "/tasks")).status, 401, "private enforce unchanged");

  for (let i = 0; i < 120; i++) equal((await request(pub, null, "GET", "/health", undefined, "198.51.100.10")).status, 200, "general limit allowance");
  // a caller that prepends a fake address still lands in its real bucket (the proxy appends the real one last)
  let limited = await request(pub, null, "GET", "/health", undefined, "203.0.113.2, 198.51.100.10");
  equal(limited.status, 429, "121st request limited by the last XFF entry despite a spoofed first one");
  assert.ok(Number(limited.retry) > 0 && Number(limited.retry) <= 60); checks++;
  equal((await request(pub, null, "GET", "/health", undefined, "198.51.100.11")).status, 200, "different IP unaffected");
  equal((await request(hub.base, null, "GET", "/health", undefined, "198.51.100.10")).status, 200, "private port unthrottled");
  for (let i = 0; i < 60; i++) {
    const forged = i % 2 ? { ...signRequest(phone, { method: "GET", path: "/tasks" }), "x-trantor-sig": "invalid" } : {};
    equal((await request(pub, null, "GET", "/tasks", undefined, "198.51.100.12", forged)).status, 401, "unsigned and bad signatures refused");
  }
  equal((await request(pub, null, "GET", "/health", undefined, "198.51.100.12")).status, 429, "failed auth costs double");
  for (let i = 0; i < 10; i++) equal((await request(pub, phone, "POST", "/enroll", {}, "198.51.100.13")).status, 403, "enroll allowance");
  limited = await request(pub, phone, "POST", "/enroll", {}, "198.51.100.13");
  equal(limited.status, 429, "11th enrollment limited"); assert.ok(Number(limited.retry) > 0); checks++;
  equal((await request(pub, null, "GET", "/health", undefined, "198.51.100.13")).status, 200, "enroll limit separate from general");

  async function open(ip = "198.51.100.14") {
    const ac = new AbortController();
    streams.push(ac);
    const path = "/stream?session=phone&events=1";
    const response = await fetch(pub + path, { headers: { ...signRequest(phone, { method: "GET", path }), "x-forwarded-for": ip }, signal: ac.signal });
    return { ac, response };
  }
  for (let i = 0; i < 5; i++) equal((await open()).response.status, 200, "five streams allowed");
  const sixth = await open();
  equal(sixth.response.status, 429, "sixth stream limited");
  assert.ok(Number(sixth.response.headers.get("retry-after")) > 0); checks++;
  await sixth.response.arrayBuffer();
  equal((await open("198.51.100.15")).response.status, 200, "stream slots isolated by IP");
  streams[0].abort();
  await sleep(100);
  equal((await open()).response.status, 200, "closed stream releases slot");
  equal(hub.stderr.includes("public refusal"), false, "refusals are aggregated, not logged per request");
} finally {
  for (const stream of streams) stream.abort();
  await hub.stop();
}

for (const mode of ["off", "warn"]) {
  const weak = await boot(mode, "");
  try {
    equal((await request(weak.base, null, "GET", "/tasks")).status, 200, `private ${mode} unchanged`);
    equal((await request(weak.publicBase, null, "GET", "/tasks")).status, 401, `public enforces despite private ${mode}`);
    equal((await request(weak.publicBase, generate(), "GET", "/tasks")).status, 401, "unknown key rejected");
    equal((await request(weak.base, null, "GET", "/health")).json.publicUrl, "", "unset URL is empty");
    const reader = generate();
    equal((await request(weak.base, reader, "POST", "/enroll", { name: "reader", scopes: [{ project: "demo", role: "read" }] })).status, 200, "private reader enrollment");
    equal((await request(weak.publicBase, reader, "GET", "/tasks?project=demo")).status, 200, "public known reader works");
    equal((await request(weak.publicBase, reader, "GET", "/tasks?project=other")).status, 403, "public reader scope stays strict");
    equal((await request(weak.publicBase, reader, "POST", "/session/prompt", { project: "demo", text: "denied" })).status, 401, "public read-only upload is refused before body processing");
  } finally { await weak.stop(); }
}
console.log(`public port: ${checks} checks passed`);

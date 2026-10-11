#!/usr/bin/env node
import "../isolate-bus.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, utimesSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { loadOrCreate, keyPath, injectIdentityKeychain, keyLocationReport } from "../../lib/identity.mjs";
import { pruneTestKeys, isTestIdentity } from "../../lib/key-prune.mjs";
import { keyUsageSnapshot } from "../../hub/key-usage.mjs";
import { startTestHub } from "../lib/test-hub.mjs";
import { sfetchJson } from "../../lib/signed-fetch.mjs";

let passed = 0;
const check = (name, condition) => { assert.ok(condition, name); passed++; console.log(`PASS ${name}`); };
const bus = process.env.AGENT_BUS_DIR;
const now = Date.now(), old = new Date(now - 9 * 86400000);
const mint = (name, age = old) => { const id = loadOrCreate(name); utimesSync(keyPath(name), age, age); return id; };
const candidate = mint("relay-selftest-111");
const live = mint("hoff-selftest-222");
const recent = mint("consumedby-333");
const fresh = mint("pctest-444", new Date());
const real = mint("operator");
const stub = mint("injcap-555");
writeFileSync(keyPath(stub.name), JSON.stringify({ name: stub.name, pubkey: stub.pubkey, keychain: "trantor-identity" }));
utimesSync(keyPath(stub.name), old, old);
const snapshot = keyUsageSnapshot({ identities: { [recent.pubkey]: { lastSeen: now - 86400000 } },
  peers: { live: { pubkey: live.pubkey, lastSeen: now } }, instances: {} }, now, 300000);
check("complete snapshot includes identity history and live peer", snapshot.complete && snapshot.identities.length === 2);
const before = readFileSync(keyPath(candidate.name), "utf8");
let result = pruneTestKeys({ snapshots: [snapshot], now });
check("default dry run lists only eligible key", result.dryRun && result.removed.join() === candidate.name);
check("dry run leaves bytes unchanged", readFileSync(keyPath(candidate.name), "utf8") === before);
check("preserves live, recent, fresh, real and stub files", [live, recent, fresh, real, stub].every(id => existsSync(keyPath(id.name))));
check("requires numbered known pattern", !isTestIdentity("relay-selftest-personal") && !isTestIdentity("my-test-key"));
check("recognizes sanitized fixture prefix", isTestIdentity("livetest_relay-selftest-123"));
check("recognizes host-qualified test names", isTestIdentity("some-host.local:hoff-selftest-123"));
const retained = keyUsageSnapshot({ peers: { old: { pubkey: real.pubkey, lastSeen: now - 86400000 } },
  instances: { stale: { durable: "a".repeat(64), lastSeen: now - 2 * 86400000 } } }, now, 300000);
check("snapshot retains offline peer and instance history", retained.identities.length === 2 && retained.identities.every(r => !r.live && r.lastSeen > 0));
check("live flag protects even with stale timestamp", !pruneTestKeys({ snapshots: [snapshot, { complete: true, identities: [{ pubkey: candidate.pubkey, lastSeen: 1, live: true }] }], now }).removed.length);
for (const snapshots of [[], [{}], [{ complete: true, identities: [{ pubkey: candidate.pubkey, lastSeen: "bad", live: false }] }]]) {
  assert.throws(() => pruneTestKeys({ snapshots, apply: true }), /hub usage/); passed++;
}
assert.throws(() => pruneTestKeys({ snapshots: [snapshot], idleDays: -1 }), /positive/); passed++;
check("longer idle window keeps nine-day file", !pruneTestKeys({ snapshots: [snapshot], idleDays: 10, now }).removed.length);
check("another hub protects a candidate", !pruneTestKeys({ snapshots: [snapshot, { complete: true, identities: [{ pubkey: candidate.pubkey, lastSeen: now, live: false }] }], now }).removed.length);

const cli = args => new Promise(resolve => {
  const child = spawn(process.execPath, ["bin/keys.mjs", ...args], { env: { ...process.env, AGENT_BUS_DIR: bus }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", b => out += b); child.stderr.on("data", b => err += b);
  child.on("close", code => resolve({ code, out, err }));
});
const server = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(snapshot)); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
process.env.RELAY_URL = `http://127.0.0.1:${server.address().port}`;
try {
  let run = await cli(["prune", "--json"]);
  check("CLI dry run is machine-readable", run.code === 0 && JSON.parse(run.out).removed.includes(candidate.name));
  check("CLI prints no private key", !run.out.includes(candidate.privkey));
  run = await cli(["prune", "--idle-days", "nope"]);
  check("CLI rejects invalid idle window", run.code === 1 && /positive/.test(run.err));
  run = await cli(["prune", "--apply", "--json"]);
  check("explicit apply removes eligible file", run.code === 0 && !existsSync(keyPath(candidate.name)));
} finally { await new Promise(resolve => server.close(resolve)); }
const outage = mint("relay-selftest-666");
const run = await cli(["prune", "--apply"]);
check("unreachable hub refuses deletion", run.code === 1 && /no keys pruned/.test(run.err) && existsSync(keyPath(outage.name)));

const large = mkdtempSync(join(bus, "large-"));
process.env.AGENT_BUS_DIR = large;
let probes = 0;
injectIdentityKeychain({ get() { probes++; return null; } });
for (let i = 0; i < 60; i++) loadOrCreate(`bulk-${i}`);
probes = 0;
const rows = keyLocationReport();
check("large status performs zero Keychain lookups", probes === 0 && rows.length === 60 && rows.every(r => r.keychain === null));
injectIdentityKeychain(null);
process.env.AGENT_BUS_DIR = bus;
rmSync(large, { recursive: true });

const hub = await startTestHub({ env: { RELAY_AUTH: "enforce", RELAY_ENROLL: "tofu" } });
try {
  const owner = loadOrCreate("prune-owner", "human");
  const enrollment = await sfetchJson(`${hub.base}/enroll`, { identity: owner, payload: { name: owner.name, kind: "human", scopes: [{ project: "*", role: "owner" }] } });
  check("test owner enrolled", enrollment.ok);
  const denied = await fetch(`${hub.base}/keys/usage`);
  check("unsigned snapshot request refused", !denied.ok);
  const response = await sfetchJson(`${hub.base}/keys/usage`, { method: "GET", identity: owner });
  const data = await response.json();
  check("owner receives complete snapshot with persisted activity", response.ok && data.complete && data.identities.some(r => r.pubkey === owner.pubkey && r.lastSeen > 0));
} finally { await hub.stop(); }
const isolated = await new Promise(resolve => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import "./test/isolate-bus.mjs"; import { loadOrCreate, keyPath } from "./lib/identity.mjs"; loadOrCreate("isolation-check"); console.log(keyPath("isolation-check"));`],
    { env: { ...process.env, HOME: bus, AGENT_BUS_DIR: bus }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", b => out += b); child.on("close", code => resolve({ code, out }));
});
check("standalone bootstrap overrides inherited bus", isolated.code === 0 && !isolated.out.startsWith(bus));
check("standalone fixture cleans its keys", !existsSync(isolated.out.trim()) && !existsSync(join(bus, "keys", "isolation-check.json")));
console.log(`${passed} passed, 0 failed`);

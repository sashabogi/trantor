import "../isolate-bus.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { injectIdentityKeychain, loadOrCreate, resolveOwnerIdentity, phoneHubAddress, loopbackHub, keyPath } from "../../lib/identity.mjs";

function home() {
  const dir = mkdtempSync(join(tmpdir(), "owner-resolution-"));
  process.env.AGENT_BUS_DIR = dir;
  process.env.TRANTOR_IDENTITY = "";
  process.env.RELAY_OWNER_IDENTITY = "";
  process.env.TRANTOR_IDENTITY_KEYCHAIN = join(dir, "isolated.keychain");
  return dir;
}

test("existing netcup owner comes from its Keychain stub and hub authorization", async t => {
  home();
  const id = loadOrCreate("sasha@mac", "human");
  writeFileSync(keyPath(id.name), JSON.stringify({ ...id, privkey: undefined }));
  injectIdentityKeychain({ get: name => name === id.name ? JSON.stringify(id) : null });
  t.after(() => injectIdentityKeychain(null));
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(url);
    assert.equal(options.headers["x-trantor-pubkey"], id.pubkey);
    assert.equal(options.redirect, "error");
    return new Response("{}", { status: 200 });
  });
  const owner = await resolveOwnerIdentity("http://100.79.242.104:4477");
  assert.equal(owner.name, "sasha@mac");
  assert.deepEqual(calls, ["http://100.79.242.104:4477/keys/usage"]);
  assert.equal(phoneHubAddress("http://100.79.242.104:4477", "https://netcup-qdrant.tail0f2afd.ts.net").hub, "https://netcup-qdrant.tail0f2afd.ts.net");
});

test("fresh remote home never creates or enrolls an owner", async t => {
  const dir = home();
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected fetch"); });
  await assert.rejects(resolveOwnerIdentity("https://hub.example.com"), /owner invite/);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(existsSync(join(dir, "keys")), false);
});

test("an unenrolled remote human is not promoted or enrolled", async t => {
  home();
  loadOrCreate("julian@mac", "human");
  const calls = [];
  t.mock.method(globalThis, "fetch", async url => {
    calls.push(url);
    return new Response('{"error":"unknown identity"}', { status: 401 });
  });
  await assert.rejects(resolveOwnerIdentity("https://hub.example.com"), /No local owner identity/);
  assert.deepEqual(calls, ["https://hub.example.com/keys/usage"]);
});

test("explicit owner config wins over unrelated human keys", async t => {
  const dir = home();
  loadOrCreate("another-human", "human");
  const owner = loadOrCreate("configured-owner", "human");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ ownerIdentity: owner.name }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.headers["x-trantor-pubkey"], owner.pubkey);
    return new Response("{}", { status: 200 });
  });
  assert.equal((await resolveOwnerIdentity("https://hub.example.com")).name, owner.name);
});

test("an unrelated unavailable human key does not hide the hub's owner", async t => {
  const dir = home();
  const owner = loadOrCreate("z-owner", "human");
  writeFileSync(join(dir, "keys/a-stale.json"), JSON.stringify({ name: "a-stale", kind: "human", pubkey: "ab".repeat(32) }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.headers["x-trantor-pubkey"], owner.pubkey);
    return new Response("{}", { status: 200 });
  });
  assert.equal((await resolveOwnerIdentity("https://hub.example.com")).name, owner.name);
});

test("an unavailable existing key is never replaced", async () => {
  const dir = home();
  mkdirSync(join(dir, "keys"));
  writeFileSync(keyPath("human"), JSON.stringify({ name: "human", kind: "human", pubkey: "ab".repeat(32) }));
  await assert.rejects(resolveOwnerIdentity("http://127.0.0.1:4477"), /key.*unavailable/);
});

test("phone checks reject local addresses while enrollment rejects deceptive hosts", () => {
  for (const base of ["http://127.0.0.1:4477", "http://localhost:4477", "http://[::1]:4477", "http://127.1/proxy", "http://0.0.0.0:4477"]) {
    assert.throws(() => phoneHubAddress(base), /Your phone cannot reach/);
  }
  for (const base of ["http://127.example.com", "http://localhost@example.com", "http://127.0.0.1/proxy", "file://localhost"]) {
    assert.equal(loopbackHub(base), false);
  }
  assert.equal(phoneHubAddress("http://100.79.242.104:4477", "https://public.example.com", true).hub, "http://100.79.242.104:4477");
});

#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const out = join(root, ".agent-bus-out");
mkdirSync(out, { recursive: true });
const bus = mkdtempSync(join(out, "migrate-selection-"));
process.env.AGENT_BUS_DIR = bus;
process.env.TRANTOR_NO_KEYCHAIN = "1";
const { loadOrCreate, keyPath, injectIdentityKeychain, migrateKeysToKeychain } = await import("../../lib/identity.mjs");
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`ok ${passed} - ${name}`); }
try {
  const names = ["sasha@mac", "admin", "trantor-disk", "codex:trantor", "MacBook-Pro-M1:relay-selftest-123", "pctest-456"];
  const fixtures = names.map(name => loadOrCreate(name));
  const before = names.map(name => readFileSync(keyPath(name), "utf8"));
  function cli(args) {
    return spawnSync(process.execPath, [join(root, "bin/keys.mjs"), "migrate", ...args], {
      encoding: "utf8", env: { ...process.env, AGENT_BUS_DIR: bus, TRANTOR_NO_KEYCHAIN: "1" },
    });
  }
  function report(args) {
    const result = cli([...args, "--dry-run", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  check("default dry run skips fixture families", () => {
    const result = report([]);
    assert.deepEqual(result.moved.sort(), names.slice(0, 4).sort());
    assert.equal(result.skippedTests, 2);
  });
  check("explicit raw name selects exactly one", () => assert.deepEqual(report(["sasha@mac"]).moved, ["sasha@mac"]));
  check("multiple names are deduplicated and explicit test names are honored", () => {
    assert.deepEqual(report([names[4], "sasha@mac", "sasha@mac"]).moved.sort(), [names[4], "sasha@mac"].sort());
  });
  check("include-tests overrides the default skip", () => assert.deepEqual(report(["--include-tests"]).moved.sort(), [...names].sort()));
  check("include-tests does not broaden explicit selection", () => assert.deepEqual(report(["--include-tests", "admin"]).moved, ["admin"]));
  check("missing name fails without selecting other keys", () => {
    const result = cli(["missing", "--dry-run", "--json"]);
    assert.equal(result.status, 1);
    const data = JSON.parse(result.stdout);
    assert.deepEqual(data.moved, []);
    assert.deepEqual(data.failed, [{ name: "missing", reason: "identity not found" }]);
  });
  check("unknown option is rejected", () => assert.equal(cli(["--include-test"]).status, 1));
  check("human dry run prints the skipped count", () => {
    const result = cli(["--dry-run"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /skipped 2 test identities/);
    assert.ok(!result.stdout.includes(names[4]));
  });
  check("dry runs and disabled migration leave all files untouched", () => {
    assert.equal(cli([]).status, 0);
    assert.deepEqual(names.map(name => readFileSync(keyPath(name), "utf8")), before);
  });
  check("reports contain no private keys", () => {
    const result = cli(["--include-tests", "--dry-run", "--json"]);
    for (const fixture of fixtures) assert.ok(!result.stdout.includes(fixture.privkey));
  });
  const store = new Map();
  injectIdentityKeychain({ get: name => store.get(name) ?? null, set: (name, value) => store.set(name, value) });
  check("default actual migration writes only non-test identities to fake Keychain", () => {
    const result = migrateKeysToKeychain();
    assert.equal(result.failed.length, 0);
    assert.equal(result.skippedTests, 2);
    assert.deepEqual([...store.keys()].sort(), names.slice(0, 4).sort());
    for (const name of names.slice(0, 4)) assert.ok(!JSON.parse(readFileSync(keyPath(name), "utf8")).privkey);
    assert.deepEqual(names.slice(4).map(name => readFileSync(keyPath(name), "utf8")), before.slice(4));
  });
  check("explicit test selection migrates only that fixture", () => {
    assert.deepEqual(migrateKeysToKeychain({ names: [names[4]] }).moved, [names[4]]);
    assert.ok(!store.has(names[5]));
  });
  check("include-tests migrates remaining fixture and preserves already entries", () => {
    const result = migrateKeysToKeychain({ includeTests: true });
    assert.deepEqual(result.moved, [names[5]]);
    assert.equal(result.already.length, 5);
  });
  console.log(`${passed} passed, 0 failed`);
} finally {
  injectIdentityKeychain(null);
  rmSync(bus, { recursive: true, force: true });
}

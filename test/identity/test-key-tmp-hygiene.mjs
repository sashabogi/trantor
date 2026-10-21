#!/usr/bin/env node
// trantor — #12126: an atomic key write must never strand its .tmp (a lost race's tmp holds a
// full PRIVATE key), and `trantor keys prune` sweeps *.tmp older than one hour (--apply only,
// never touching a real key file).
import "../isolate-bus.mjs";
import assert from "node:assert/strict";
import { writeFileSync, utimesSync, existsSync, readdirSync, symlinkSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { loadOrCreate, loadOrCreateInstance, keyPath, keysDir, instanceKeyPath, injectIdentityKeychain } from "../../lib/identity.mjs";
import { pruneStaleTmp } from "../../lib/key-prune.mjs";

let passed = 0;
const check = (name, condition) => { assert.ok(condition, name); passed++; console.log(`PASS ${name}`); };
const bus = process.env.AGENT_BUS_DIR;
const tmpsIn = (dir) => { try { return readdirSync(dir).filter((f) => f.endsWith(".tmp")).sort(); } catch { return []; } };
const now = Date.now(), old = new Date(now - 2 * 3600_000), fresh = new Date(now);
const instDir = join(keysDir(), "instances");

// [1] a successful durable mint strands nothing
const id = loadOrCreate("tmp-hygiene-a");
check("minted key lands at its path", !!id && existsSync(keyPath("tmp-hygiene-a")));
check("successful mint leaves no tmp behind", tmpsIn(keysDir()).length === 0);

// [2] THE regression: an instance file that appears (corrupt) between the top check and the
// post-write check sends loadOrCreateInstance down the race-loser return — pre-fix that returned
// WITHOUT unlinking its tmp, stranding a private key per racing session start.
const durable = loadOrCreate("tmp-hygiene-b");
const raced = instanceKeyPath("tmp-hygiene-b", "sess-race");
mkdirSync(instDir, { recursive: true });
writeFileSync(raced, "{corrupted");
const inst = loadOrCreateInstance(durable, "sess-race");
check("raced instance mint still returns a usable key", !!(inst?.pubkey && inst?.privkey && inst?.endorsement));
check("race-loser instance tmp is cleaned up", tmpsIn(instDir).length === 0);

// [3] the Keychain stub rewrite (writeKeyStub) strands nothing on the happy path
{
  const store = new Map();
  injectIdentityKeychain({ get: (a) => store.get(a) ?? null, set: (a, v) => store.set(a, v) });
  const mig = await import("../../lib/identity.mjs").then((m) => m.migrateKeysToKeychain({ names: ["tmp-hygiene-a"] }));
  check("migration to keychain succeeds in-fixture", mig.moved.includes("tmp-hygiene-a"), JSON.stringify(mig.failed));
  check("stub rewrite leaves no tmp behind", tmpsIn(keysDir()).length === 0);
  injectIdentityKeychain(null);
}

// [4] pruneStaleTmp: only aged *.tmp in the keys tree; never a real key, never a symlink
mkdirSync(instDir, { recursive: true });
const agedTmp = join(keysDir(), "sasha_mac.json.13017.dc830a7d.tmp");
const freshTmp = join(keysDir(), "other.json.999.abcdef01.tmp");
const agedInstTmp = join(instDir, "x@sess.json.1.2222.tmp");
const realKey = keyPath("operator-keep");
writeFileSync(agedTmp, "junk"); utimesSync(agedTmp, old, old);
writeFileSync(freshTmp, "junk"); utimesSync(freshTmp, fresh, fresh);
writeFileSync(agedInstTmp, "junk"); utimesSync(agedInstTmp, old, old);
check("aged real key exists for the guard", !!loadOrCreate("operator-keep") && existsSync(realKey));
utimesSync(realKey, old, old);
const linkTmp = join(keysDir(), "link.json.1.1.tmp");
symlinkSync(realKey, linkTmp);

let sweep = pruneStaleTmp({ now });
check("dry run lists exactly the aged tmp files", sweep.dryRun && sweep.removed.length === 2 && sweep.removed.includes(agedTmp) && sweep.removed.includes(agedInstTmp));
check("dry run deletes nothing", existsSync(agedTmp) && existsSync(agedInstTmp) && existsSync(freshTmp));
sweep = pruneStaleTmp({ now, apply: true });
check("apply removes aged tmp in keys root and instances dir", !sweep.dryRun && !existsSync(agedTmp) && !existsSync(agedInstTmp));
check("fresh tmp is kept (writer may still be mid-write)", existsSync(freshTmp));
check("aged REAL key file is never touched", existsSync(realKey));
check("symlinked tmp is never followed or removed", existsSync(linkTmp));
rmSync(linkTmp); rmSync(freshTmp);
assert.throws(() => pruneStaleTmp({ maxAgeMs: 0 }), /positive/); passed++;

// [5] CLI: prune reports the tmp sweep in --json and gates deletion behind --apply
const cli = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, ["bin/keys.mjs", ...args], { env: { ...process.env, AGENT_BUS_DIR: bus }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (b) => out += b); child.stderr.on("data", (b) => err += b);
  child.on("close", (code) => resolve({ code, out, err }));
});
const server = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ complete: true, identities: [] })); });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.RELAY_URL = `http://127.0.0.1:${server.address().port}`;
try {
  const cliTmp = join(keysDir(), "cli.json.7.777777aa.tmp");
  writeFileSync(cliTmp, "junk"); utimesSync(cliTmp, old, old);
  let run = await cli(["prune", "--json"]);
  const parsed = JSON.parse(run.out);
  check("CLI dry-run tmp sweep is machine-readable", run.code === 0 && parsed.tmp.dryRun && parsed.tmp.removed.includes(cliTmp));
  check("CLI dry-run keeps the tmp", existsSync(cliTmp));
  run = await cli(["prune", "--apply", "--json"]);
  const applied = JSON.parse(run.out);
  check("CLI --apply removes the aged tmp", run.code === 0 && applied.tmp.removed.includes(cliTmp) && !existsSync(cliTmp));
  check("CLI --apply never removes a key file", existsSync(realKey));
} finally { await new Promise((resolve) => server.close(resolve)); }

console.log(`${passed} passed, 0 failed`);

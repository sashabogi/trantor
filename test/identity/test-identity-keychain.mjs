#!/usr/bin/env node
// The identity keychain store (#11370): migrate moves private keys off disk into the Keychain —
// here an INJECTED FAKE, plus the real `security` binary against a THROWAWAY keychain — reads go
// Keychain-first through a per-process cache, a locked Keychain falls back to the file with one
// warning line, and a stub without a reachable private key is never re-minted. AGENT_BUS_DIR is
// always a temp dir inside the worktree: the real ~/.agent-bus and login keychain are never touched.
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "../drill-env.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUT = join(ROOT, ".agent-bus-out");
mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); } };

const DIRS = [];
const tmpBus = () => { const d = mkdtempSync(join(OUT, "idkc-")); DIRS.push(d); return d; };
const {
  load, loadOrCreate, keyPath, signRequest, verifyRequest,
  migrateKeysToKeychain, keyLocationReport, injectIdentityKeychain, IDENTITY_SERVICE,
} = await import("../../lib/identity.mjs");

function fakeKeychain() {
  const store = new Map();
  const state = { locked: false, gets: 0 };
  const api = {
    get(k) { state.gets++; if (state.locked) throw new Error("keychain is locked"); return store.has(k) ? store.get(k) : null; },
    set(k, v) { if (state.locked) throw new Error("keychain is locked"); store.set(k, v); },
    remove(k) { store.delete(k); },
  };
  return { store, state, api };
}

// Warnings are one stderr line per process; capture them without touching the console for real.
function captureStderr(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(" "));
  try { fn(); } finally { console.error = orig; }
  return lines;
}

// A fresh room: own bus dir, own fake keychain, cache cleared (injecting resets both).
function room(name) {
  const bus = tmpBus();
  process.env.AGENT_BUS_DIR = bus;
  const kc = fakeKeychain();
  injectIdentityKeychain(kc.api);
  return { bus, kc, name };
}
const readKey = (name) => JSON.parse(readFileSync(keyPath(name), "utf8"));

try {
  console.log("\n# mint: new keys are born as FILES even when the keychain is up");
  {
    const { kc, name } = room("alice:proj");
    const id = loadOrCreate(name, "agent");
    ok("minted a usable identity", /^[0-9a-f]{64}$/.test(id.pubkey) && /^[0-9a-f]{64}$/.test(id.privkey));
    ok("the private key is in the file", readKey(name).privkey === id.privkey);
    ok("the keychain was not touched", kc.store.size === 0);
  }

  console.log("\n# migrate: keychain copy, signature round-trip, then a pubkey-only stub");
  {
    const { kc, name } = room("migrate-me:proj");
    const id = loadOrCreate(name, "agent");
    const dry = migrateKeysToKeychain({ dryRun: true });
    ok("dry run names the move", dry.moved.join() === name && dry.dryRun);
    ok("dry run writes nothing", readKey(name).privkey === id.privkey && kc.store.size === 0);
    const r = migrateKeysToKeychain({});
    ok("moved the key", r.moved.join() === name && !r.failed.length, JSON.stringify(r.failed));
    ok("the keychain holds the identity", kc.store.has(name) && JSON.parse(kc.store.get(name)).privkey === id.privkey);
    const stub = readKey(name);
    ok("the file is a pubkey-only stub", !stub.privkey && stub.pubkey === id.pubkey && stub.keychain === IDENTITY_SERVICE);
    ok("the stub keeps name/kind/createdAt", stub.name === name && stub.kind === "agent" && stub.createdAt === id.createdAt);
    ok("the stub is still 0600", (statSync(keyPath(name)).mode & 0o777) === 0o600);
    ok("the keychain service name is the contract's", IDENTITY_SERVICE === "trantor-identity");
    const again = migrateKeysToKeychain({});
    ok("a second run moves nothing", !again.moved.length && again.already.join() === name);

    const before = kc.state.gets;
    const loaded = load(name);
    ok("load resolves stub + keychain into the full identity", loaded?.privkey === id.privkey && loaded.pubkey === id.pubkey);
    load(name); load(name);
    ok("the keychain is read ONCE per process", kc.state.gets === before + 1, `gets ${kc.state.gets - before}`);
    const hdrs = signRequest(loaded, { method: "GET", path: "/peers" });
    ok("the migrated identity still signs and verifies", verifyRequest({ headers: hdrs, method: "GET", path: "/peers" }).ok);
  }

  console.log("\n# a file that still carries its key WINS over a stale keychain entry (rotate safety)");
  {
    const { kc, name } = room("bob:proj");
    const id = loadOrCreate(name, "agent");
    const stale = loadOrCreate("someone-else:proj", "agent");   // a different keypair to pose as the stale entry
    kc.store.set(name, JSON.stringify(stale));
    injectIdentityKeychain(kc.api);                             // clear the per-process cache
    const loaded = load(name);
    ok("the file's key answers, not the stale keychain copy", loaded?.privkey === id.privkey);
  }

  console.log("\n# locked keychain: warn once, never re-mint over an existing record");
  {
    const { kc, name } = room("carol:proj");
    const id = loadOrCreate(name, "agent");
    migrateKeysToKeychain({});
    kc.state.locked = true;
    injectIdentityKeychain(kc.api);                             // fresh cache; the fake now throws
    const lines = [];
    let loaded = "unset", recreated = "unset";
    lines.push(...captureStderr(() => { loaded = load(name); }));
    lines.push(...captureStderr(() => { recreated = loadOrCreate(name); }));
    ok("a locked keychain with only a stub loads as null", loaded === null);
    ok("exactly one warning line", lines.length === 1 && /unavailable|locked/i.test(lines[0]), lines.join(" | "));
    ok("loadOrCreate refuses to re-mint over the stub", recreated === null);
    const stub = readKey(name);
    ok("the stub is unchanged (no history split)", stub.pubkey === id.pubkey && !stub.privkey);

    kc.state.locked = false;
    kc.store.delete(name);                                      // the entry is simply GONE
    injectIdentityKeychain(kc.api);
    const missLines = captureStderr(() => { load(name); });
    ok("a stub with a missing entry also refuses", load(name) === null);
    ok("…and says to re-run migrate", missLines.length === 1 && /keys migrate/.test(missLines[0]), missLines.join(" | "));
  }

  console.log("\n# the keychain entry is self-sufficient: a lost stub file still loads");
  {
    const { name } = room("dave:proj");
    const id = loadOrCreate(name, "agent");
    migrateKeysToKeychain({});
    unlinkSync(keyPath(name));
    injectIdentityKeychain((() => { const kc2 = fakeKeychain(); return kc2.api; })());
    ok("without the file AND without the entry there is nothing", load(name) === null);
  }
  {
    const bus = tmpBus();
    process.env.AGENT_BUS_DIR = bus;
    const kc = fakeKeychain();
    injectIdentityKeychain(kc.api);
    const name = "erin:proj";
    const id = loadOrCreate(name, "agent");
    migrateKeysToKeychain({});
    unlinkSync(keyPath(name));
    injectIdentityKeychain(kc.api);                             // cache clear, entry survives in the fake
    const loaded = load(name);
    ok("keychain alone rebuilds the identity", loaded?.privkey === id.privkey && loaded.pubkey === id.pubkey);
  }

  console.log("\n# a failed store leaves the file untouched");
  {
    const { kc, name } = room("frank:proj");
    const id = loadOrCreate(name, "agent");
    kc.api.set = () => { throw new Error("no space"); };
    const r = migrateKeysToKeychain({});
    ok("the failure is reported by name", r.failed.length === 1 && r.failed[0].name === name && /no space/.test(r.failed[0].reason));
    ok("the file still holds the private key", readKey(name).privkey === id.privkey);
  }

  console.log("\n# status reports WHERE, never WHAT");
  {
    const { name } = room("grace:proj");
    const moved = loadOrCreate("heidi:proj", "agent");
    migrateKeysToKeychain({});                                  // moves heidi only
    const plain = loadOrCreate(name, "agent");                  // minted after migrate → stays a file
    injectIdentityKeychain(fakeKeychain().api);                 // heidi's entry is gone with the old fake
    const rows = keyLocationReport();
    const g = rows.find((r) => r.name === name), h = rows.find((r) => r.name === "heidi:proj");
    ok("an unmigrated key reads as file (plaintext)", g?.where === "file (plaintext)", g?.where);
    ok("a stub with a lost entry reads as NO USABLE PRIVATE KEY", h?.where === "NO USABLE PRIVATE KEY", h?.where);
    const blob = JSON.stringify(rows);
    ok("no key material in the report", !blob.includes(plain.privkey) && !blob.includes(moved.privkey));
  }

  console.log("\n# trantor keys: the CLI verbs (no keychain selected → files stay)");
  {
    const bus = tmpBus();
    process.env.AGENT_BUS_DIR = bus;
    process.env.TRANTOR_NO_KEYCHAIN = "1";                      // this process must not even READ the login keychain
    injectIdentityKeychain(null);
    const id = loadOrCreate("ivan:proj", "agent");
    delete process.env.TRANTOR_NO_KEYCHAIN;
    const env = drillEnv({ AGENT_BUS_DIR: bus, TRANTOR_NO_KEYCHAIN: "1" });
    const cli = (args) => spawnSync(process.execPath, [join(ROOT, "bin", "keys.mjs"), ...args], { encoding: "utf8", env });
    let r = cli(["status"]);
    ok("status exits 0 and names the key's home", r.status === 0 && r.stdout.includes("ivan:proj") && r.stdout.includes("file (plaintext)"), r.stderr);
    ok("status never prints key material", !`${r.stdout}${r.stderr}`.includes(id.privkey));
    r = cli(["status", "--json"]);
    const rows = JSON.parse(r.stdout).rows;
    ok("status --json is machine-readable", rows.find((x) => x.name === "ivan:proj")?.where === "file (plaintext)");
    r = cli(["migrate"]);
    ok("migrate without a keychain is a no-op, exit 0", r.status === 0 && /stay in files/.test(r.stdout), r.stderr);
    ok("…and the file is untouched", readKey("ivan:proj").privkey === id.privkey);
    r = cli(["bogus"]);
    ok("an unknown verb is a usage error", r.status === 1 && r.stderr.includes("usage:"));
  }

  if (process.platform === "darwin" && existsSync("/usr/bin/security")) {
    console.log("\n# the real security binary on a THROWAWAY keychain (the login keychain is never touched)");
    const bus = tmpBus();
    process.env.AGENT_BUS_DIR = bus;
    const name = "judy:proj";
    const kc = join(bus, "drill-identity.keychain-db");
    execSync(`/usr/bin/security create-keychain -p drillpw ${JSON.stringify(kc)}`);
    // Every real `security` call below — including the mint's existence probe — aims at the
    // throwaway keychain only.
    process.env.TRANTOR_IDENTITY_KEYCHAIN = kc;
    injectIdentityKeychain(null);
    const id = loadOrCreate(name, "agent");
    const env = drillEnv({ AGENT_BUS_DIR: bus, TRANTOR_IDENTITY_KEYCHAIN: kc });
    try {
      const mig = spawnSync(process.execPath, [join(ROOT, "bin", "keys.mjs"), "migrate"], { encoding: "utf8", env });
      ok("CLI migrate exits 0", mig.status === 0, `${mig.stdout} ${mig.stderr}`.slice(0, 300));
      ok("CLI migrate never prints key material", !`${mig.stdout}${mig.stderr}`.includes(id.privkey));
      ok("the file is now a stub", !readKey(name).privkey && readKey(name).pubkey === id.pubkey);
      const found = spawnSync("/usr/bin/security", ["find-generic-password", "-a", name, "-s", IDENTITY_SERVICE, "-w", kc], { encoding: "utf8" });
      ok("security finds the entry under trantor-identity", found.status === 0 && JSON.parse(found.stdout).pubkey === id.pubkey);
      const st = spawnSync(process.execPath, [join(ROOT, "bin", "keys.mjs"), "status"], { encoding: "utf8", env });
      ok("CLI status reads keychain", st.status === 0 && st.stdout.includes("keychain"), st.stdout);

      // The real READ path, in-process: load resolves stub + real keychain and the key still signs.
      delete process.env.TRANTOR_NO_KEYCHAIN;
      process.env.TRANTOR_IDENTITY_KEYCHAIN = kc;
      injectIdentityKeychain(null);
      const loaded = load(name);
      ok("load resolves through the real keychain", loaded?.privkey === id.privkey);
      const hdrs = signRequest(loaded, { method: "GET", path: "/peers" });
      ok("the real-keychain identity signs and verifies", verifyRequest({ headers: hdrs, method: "GET", path: "/peers" }).ok);
      delete process.env.TRANTOR_IDENTITY_KEYCHAIN;
    } finally {
      execSync(`/usr/bin/security delete-keychain ${JSON.stringify(kc)}`);
    }
  }

  console.log(`\ntest-identity-keychain: ${pass} passed, ${fail} failed`);
  delete process.env.AGENT_BUS_DIR;
  for (const d of DIRS) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error(`harness error: ${e.stack || e}`);
  for (const d of DIRS) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  process.exit(1);
}

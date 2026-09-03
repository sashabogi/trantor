#!/usr/bin/env node
// trantor — session-instance subkeys acceptance (docs/INSTANCE-KEYS-CONTRACT.md).
// Isolated ONLY: random ports, TMP HOME+DATA+KEYS dirs — never :4477 or real ~/.agent-bus.
// Real Ed25519 via lib/identity.mjs; the hub under RELAY_AUTH=enforce is the system under test.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { drillEnv } from "./drill-env.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url)).replace(/\/[^/]+$/, "");
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); } };

function mDir() { return mkdtempSync(join(tmpdir(), `tii-${process.pid}-${randomBytes(3).toString("hex")}-`)); }
let HUBS = [];
async function startHub(extraEnv = {}) {
  const dir = mDir();
  mkdirSync(join(dir, ".agent-bus"), { recursive: true });
  const port = 5000 + Math.floor(Math.random() * 20000);
  const env = {
    ...drillEnv(), HOME: dir, AGENT_BUS_DIR: join(dir, ".agent-bus"), RELAY_DATA_DIR: dir,
    RELAY_PORT: String(port), RELAY_HOST: "127.0.0.1", RELAY_ONLINE_MS: "1500", ...extraEnv,
  };
  delete env.RELAY_URL;
  const child = spawn(process.execPath, [join(HERE, "hub.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let er = ""; child.stderr.on("data", d => { er += d.toString(); });
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(300) });
      if (r.ok) { const h = { child, dir, port, base: `http://127.0.0.1:${port}` }; HUBS.push(h); return h; }
    } catch {}
    await sleep(80);
  }
  try { child.kill(); } catch {}
  throw new Error(`hub :${port} no start err=${er.slice(-400)}`);
}
function stopAll() { for (const h of HUBS) { try { h.child.kill(); } catch {} try { rmSync(h.dir, { recursive: true, force: true }); } catch {} } HUBS = []; }

const {
  generate, signRequest, loadOrCreate, loadOrCreateInstance, instanceHeaders,
  verifyEndorsement, endorsementString, instanceKeyPath,
} = await import("./lib/identity.mjs");

// v1 signature made with WHATEVER identity is passed + optional instance headers on top.
function hdrsFor(id, method, path, body, withInstance = false) {
  const b = body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body));
  const v1 = signRequest({ pubkey: id.pubkey, privkey: id.privkey }, { method, path, body: b });
  return withInstance ? { ...v1, ...instanceHeaders(id) } : v1;
}
async function sFetch(base, id, method, path, bodyObj, withInstance = false) {
  const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  const hdrs = id ? hdrsFor(id, method, path, body, withInstance) : {};
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...hdrs }, body });
  let j; try { j = JSON.parse(await r.text()); } catch { j = {}; }
  return { status: r.status, json: j };
}

try {
  console.log("\n# test-identity-instances — docs/INSTANCE-KEYS-CONTRACT.md (isolated)");

  console.log("\n[unit] mint + endorse:");
  {
    const dir = mDir();
    process.env.AGENT_BUS_DIR = join(dir, ".agent-bus");
    const durable = loadOrCreate("inst-unit:proj", "agent");
    const inst = loadOrCreateInstance(durable, "sess-abc123");
    ok("instance minted with endorsement", !!(inst?.pubkey && inst?.privkey && inst?.endorsement));
    ok("instance file exists at contract path", !!readFileSync(instanceKeyPath("inst-unit:proj", "sess-abc123"), "utf8"));
    ok("endorsement verifies", verifyEndorsement({
      durablePubkey: durable.pubkey, instancePubkey: inst.pubkey,
      instanceId: "sess-abc123", createdAt: inst.createdAt, endorsement: inst.endorsement,
    }));
    ok("mint is idempotent (same key back)", loadOrCreateInstance(durable, "sess-abc123").pubkey === inst.pubkey);
    const other = generate();
    ok("endorsement rejects a different durable key", !verifyEndorsement({
      durablePubkey: other.pubkey, instancePubkey: inst.pubkey,
      instanceId: "sess-abc123", createdAt: inst.createdAt, endorsement: inst.endorsement,
    }));
    ok("endorsement rejects a tampered instanceId", !verifyEndorsement({
      durablePubkey: durable.pubkey, instancePubkey: inst.pubkey,
      instanceId: "sess-EVIL", createdAt: inst.createdAt, endorsement: inst.endorsement,
    }));
    ok("endorsement rejects a swapped instance pubkey", !verifyEndorsement({
      durablePubkey: durable.pubkey, instancePubkey: other.pubkey,
      instanceId: "sess-abc123", createdAt: inst.createdAt, endorsement: inst.endorsement,
    }));
    delete process.env.AGENT_BUS_DIR;
  }

  console.log("\n[hub] endorsed instance authenticates AS the durable identity (enforce):");
  {
    const hub = await startHub({ RELAY_AUTH: "enforce", RELAY_ENROLL: "tofu" });
    const dir = mDir();
    process.env.AGENT_BUS_DIR = join(dir, ".agent-bus");
    const durable = loadOrCreate("alice:proj", "agent");
    const enroll = await sFetch(hub.base, durable, "POST", "/enroll", { pubkey: durable.pubkey, name: "alice:proj", kind: "agent" });
    ok("durable enrolls (tofu loopback)", enroll.status < 400, `status ${enroll.status}`);

    const instA = loadOrCreateInstance(durable, "sessA");
    const instB = loadOrCreateInstance(durable, "sessB");

    let r = await sFetch(hub.base, instA, "GET", "/inbox?session=alice:proj&since=0&peek=1", undefined, true);
    ok("instance-signed read passes under enforce", r.status === 200, `status ${r.status}`);

    r = await sFetch(hub.base, instA, "POST", "/send", { from: "alice:proj", to: "all", text: "hello from instance A", project: "proj" }, true);
    ok("instance-signed write lands as the durable name", r.status === 200, `status ${r.status}`);

    const rando = generate();
    r = await sFetch(hub.base, { ...rando, name: "x" }, "GET", "/inbox?session=alice:proj&since=0&peek=1");
    ok("un-endorsed unknown key still 401s", r.status === 401, `status ${r.status}`);

    // tampered endorsement: claim durable, present instance key, but endorsement is for sessA while
    // we claim sessB's id — must fail closed.
    const forged = { ...instA, instanceId: "sessB" };
    r = await sFetch(hub.base, forged, "GET", "/inbox?session=alice:proj&since=0&peek=1", undefined, true);
    ok("mismatched endorsement 401s", r.status === 401, `status ${r.status}`);

    // legacy compat: plain durable-signed request unchanged
    r = await sFetch(hub.base, durable, "GET", "/inbox?session=alice:proj&since=0&peek=1");
    ok("legacy durable-signed read still passes", r.status === 200, `status ${r.status}`);

    console.log("\n[hub] supersession:");
    r = await sFetch(hub.base, durable, "POST", "/instance/supersede", { name: "alice:proj", exceptInstanceId: "sessB" });
    ok("supersede accepted from the durable identity", r.status === 200 && r.json.ok, `status ${r.status}`);
    ok("exactly one instance flipped", r.json.superseded === 1, `flipped ${r.json.superseded}`);

    r = await sFetch(hub.base, instA, "GET", "/inbox?session=alice:proj&since=0&peek=1", undefined, true);
    ok("superseded instance read carries superseded:true", r.status === 200 && r.json.superseded === true, JSON.stringify(r.json).slice(0, 120));

    r = await sFetch(hub.base, instB, "GET", "/inbox?session=alice:proj&since=0&peek=1", undefined, true);
    ok("surviving instance reads clean", r.status === 200 && r.json.superseded !== true, JSON.stringify(r.json).slice(0, 120));

    r = await sFetch(hub.base, instA, "POST", "/send", { from: "alice:proj", to: "all", text: "last report from a dying twin", project: "proj" }, true);
    ok("superseded write still lands (never break the last report)", r.status === 200, `status ${r.status}`);

    // ---- the claim lapses when the claimant dies (regression, 2026-08-27) -----------------------
    // 7e014e2a claimed the baton at 22:57, died by 23:13, and the orchestrator pane was STILL being
    // told to stand down for it an hour later, because `superseded` was documented "never unset".
    // The claim stays stored; it is only REPORTED while the instance it spared is still being seen.
    {
      const lapse = await startHub({ RELAY_AUTH: "enforce", RELAY_ENROLL: "tofu",
        RELAY_ONLINE_MS: "1500", RELAY_SUPERSEDE_GRACE_MS: "1200" });
      const d2 = mDir();
      process.env.AGENT_BUS_DIR = join(d2, ".agent-bus");
      const dur2 = loadOrCreate("bob:proj", "agent");
      await sFetch(lapse.base, dur2, "POST", "/enroll", { pubkey: dur2.pubkey, name: "bob:proj", kind: "agent" });
      const older = loadOrCreateInstance(dur2, "sessOld");
      const claimant = loadOrCreateInstance(dur2, "sessNew");

      // both instances exist on the hub, then the newcomer claims the baton
      await sFetch(lapse.base, older, "GET", "/inbox?session=bob:proj&since=0&peek=1", undefined, true);
      await sFetch(lapse.base, claimant, "GET", "/inbox?session=bob:proj&since=0&peek=1", undefined, true);
      await sFetch(lapse.base, dur2, "POST", "/instance/supersede", { name: "bob:proj", exceptInstanceId: "sessNew" });

      let x = await sFetch(lapse.base, older, "GET", "/inbox?session=bob:proj&since=0&peek=1", undefined, true);
      ok("live claimant still muzzles the older twin", x.json.superseded === true, JSON.stringify(x.json).slice(0, 120));

      // claimant goes quiet past the grace window — it died, nobody is carrying the baton
      await sleep(1500);
      x = await sFetch(lapse.base, older, "GET", "/inbox?session=bob:proj&since=0&peek=1", undefined, true);
      ok("a claimant that stops being seen releases the muzzle", x.json.superseded !== true, JSON.stringify(x.json).slice(0, 160));

      // ...and the claim was not destroyed: the claimant coming back re-engages it
      await sFetch(lapse.base, claimant, "GET", "/inbox?session=bob:proj&since=0&peek=1", undefined, true);
      x = await sFetch(lapse.base, older, "GET", "/inbox?session=bob:proj&since=0&peek=1", undefined, true);
      ok("a returning claimant re-engages the muzzle without re-claiming", x.json.superseded === true, JSON.stringify(x.json).slice(0, 160));

      // the claimant itself never reads as superseded
      x = await sFetch(lapse.base, claimant, "GET", "/inbox?session=bob:proj&since=0&peek=1", undefined, true);
      ok("the claimant itself always reads clean", x.json.superseded !== true, JSON.stringify(x.json).slice(0, 120));

      // Records claimed BEFORE supersededBy existed carry no claimant — this is exactly the shape on
      // the live hub at upgrade time. They fall back to "is any OTHER live instance of this name still
      // carrying it?". A blanket supersede (no exceptInstanceId) writes the same shape, so we reach the
      // branch through the API instead of hand-surgery on bus.json.
      await sFetch(lapse.base, dur2, "POST", "/instance/supersede", { name: "bob:proj" });
      const orphan = loadOrCreateInstance(dur2, "sessOrphan");
      await sFetch(lapse.base, orphan, "GET", "/inbox?session=bob:proj&since=0&peek=1", undefined, true);
      x = await sFetch(lapse.base, orphan, "GET", "/inbox?session=bob:proj&since=0&peek=1", undefined, true);
      ok("an instance born after a blanket supersede is not muzzled by it",
        x.json.superseded !== true, JSON.stringify(x.json).slice(0, 160));

      // sessNew was blanket-superseded too and has no claimant recorded — the legacy shape. It stays
      // muzzled while sessOrphan (live, not superseded) is carrying the name...
      x = await sFetch(lapse.base, claimant, "GET", "/inbox?session=bob:proj&since=0&peek=1", undefined, true);
      ok("a claimless flag holds while another live instance carries the name",
        x.json.superseded === true, JSON.stringify(x.json).slice(0, 160));

      // ...and lapses once that carrier goes quiet too. This is the upgrade path that unsticks a hub
      // whose records were written before this fix existed.
      await sleep(1500);
      x = await sFetch(lapse.base, claimant, "GET", "/inbox?session=bob:proj&since=0&peek=1", undefined, true);
      ok("a claimless flag lapses once nothing live carries the name (upgrade path)",
        x.json.superseded !== true, JSON.stringify(x.json).slice(0, 160));

      process.env.AGENT_BUS_DIR = join(dir, ".agent-bus");
    }

    const evil = loadOrCreate("mallory:proj", "agent");
    await sFetch(hub.base, evil, "POST", "/enroll", { pubkey: evil.pubkey, name: "mallory:proj", kind: "agent" });
    r = await sFetch(hub.base, evil, "POST", "/instance/supersede", { name: "alice:proj" });
    ok("another identity cannot supersede alice (enforce)", r.status === 403, `status ${r.status}`);

    delete process.env.AGENT_BUS_DIR;
  }
} finally {
  stopAll();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// test/cli/test-pair.mjs — `trantor pair` (#12115): the owner identity mints a phone-pairing
// invite on an enforce hub, the link parses to hub+token, and the token enrolls a fresh key.
// Isolated: random port, TMP HOME — never :4477 or the real ~/.agent-bus.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate, loadOrCreate, signRequest } from "../../lib/identity.mjs";
import { drillEnv } from "../drill-env.mjs";
import { startTestHub } from "../lib/test-hub.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const CLI = join(ROOT, "bin", "cli.mjs");
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); } };

async function sFetch(id, method, path, bodyObj) {
  const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  const hdrs = signRequest(id, { method, path, body: body });
  const r = await fetch(HUB.base + path, { method, headers: { "content-type": "application/json", ...hdrs }, body });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

// `trantor pair` as a child process: RELAY_URL pins the test hub, HOME/AGENT_BUS_DIR pin the keys.
function runPair(extraArgs, home) {
  return spawnSync(process.execPath, [CLI, "pair", ...extraArgs], {
    encoding: "utf8",
    cwd: ROOT,
    env: drillEnv({ HOME: home, RELAY_URL: HUB.base, TRANTOR_NO_UPDATE_CHECK: "1", TRANTOR_IDENTITY: "admin" }),
    timeout: 30000,
  });
}

const tmp = mkdtempSync(join(tmpdir(), "trantor-pair-"));
let HUB = null;

try {
  console.log("\n# test-pair — trantor pair (isolated, no :4477)");
  HUB = await startTestHub({ env: { RELAY_AUTH: "enforce", RELAY_ENROLL: "tofu" } });

  // The CLI signs as the operator's owner identity (TRANTOR_IDENTITY, here "admin"). Mint it in the test HOME
  // and TOFU-enroll it with a wildcard owner scope so /invite answers.
  process.env.AGENT_BUS_DIR = join(tmp, ".agent-bus");
  const admin = loadOrCreate("admin", "human");
  delete process.env.AGENT_BUS_DIR;
  ok("admin identity minted in test HOME", !!admin?.privkey);
  const enroll = await sFetch(admin, "POST", "/enroll", { name: "admin", kind: "human", scopes: [{ project: "*", role: "owner" }] });
  ok("admin TOFU-enrolled with owner scope", enroll.status < 400, `status ${enroll.status} ${JSON.stringify(enroll.json)}`);

  console.log("\n[1] pair --json --role owner mints an enrollable link:");
  {
    const r = runPair(["--json", "--role", "owner"], tmp);
    ok("pair exits 0", r.status === 0, `exit ${r.status} out=${r.stdout.slice(0, 200)} err=${r.stderr.slice(0, 200)}`);
    let j = null;
    try { j = JSON.parse(r.stdout); } catch {}
    ok("stdout is {link, token, hub, expiresAt} JSON", !!j && /^trantor:\/\//.test(j.link || "") && /^[0-9a-f]{64}$/.test(j.token || "") && j.hub === HUB.base && Number.isFinite(j.expiresAt),
      JSON.stringify(j || r.stdout).slice(0, 200));
    const m = j && /^trantor:\/\/enroll\?hub=([^&]+)&token=([0-9a-f]{64})$/.exec(j.link);
    ok("link parses: trantor://enroll?hub=<enc>&token=<64hex>", !!m, j?.link || "(no link)");
    ok("link hub round-trips the test hub", !!m && decodeURIComponent(m[1]) === HUB.base, m && decodeURIComponent(m[1]));
    ok("expiresAt ~10 minutes out", !!j && j.expiresAt > Date.now() + 570000 && j.expiresAt < Date.now() + 630000,
      j && `${Math.round((j.expiresAt - Date.now()) / 1000)}s`);

    if (m) {
      const phone = generate();
      const use1 = await sFetch(phone, "POST", "/enroll", { token: j.token, name: "phone", kind: "human" });
      ok("token enrolls a fresh key 2xx", use1.status < 400, `status ${use1.status} ${JSON.stringify(use1.json)}`);
      ok("enrolled with the invited scope (* owner)", JSON.stringify(use1.json.scopes || []) === JSON.stringify([{ project: "*", role: "owner" }]),
        JSON.stringify(use1.json.scopes || []));
      const reuse = await sFetch(generate(), "POST", "/enroll", { token: j.token, name: "reuse", kind: "human" });
      ok("token is single-use (second enroll 403)", reuse.status === 403, `got ${reuse.status}`);
    }
  }

  console.log("\n[2] human output carries the link and the expiry:");
  {
    const r = runPair(["--role", "owner"], tmp);
    ok("pair (human mode) exits 0", r.status === 0, `exit ${r.status} err=${r.stderr.slice(0, 200)}`);
    ok("prints a trantor://enroll link", /trantor:\/\/enroll\?hub=[^&]+&token=[0-9a-f]{64}/.test(r.stdout), r.stdout.slice(0, 200));
    ok("says how long it lives", /Expires in \d+ minutes?/.test(r.stdout), r.stdout.slice(0, 200));
  }

  console.log("\n[3] the default pairs the phone as an approver, never owner (#12113):");
  {
    const r = runPair(["--json"], tmp);
    ok("default pair exits 0", r.status === 0, `exit ${r.status} err=${r.stderr.slice(0, 200)}`);
    let j = null;
    try { j = JSON.parse(r.stdout); } catch {}
    const phone = generate();
    const use = j?.token ? await sFetch(phone, "POST", "/enroll", { token: j.token, name: "phone-approver", kind: "human" }) : { status: 0, json: {} };
    const scopes = use.json?.scopes || [];
    ok("the enrolled phone holds *:approver and nothing more", use.status < 400 && scopes.length === 1 && scopes[0].project === "*" && scopes[0].role === "approver",
      `status ${use.status} ${JSON.stringify(scopes)}`);
  }

  console.log("\n[3b] --help prints usage and mints nothing:");
  {
    const r = runPair(["--help"], tmp);
    ok("--help exits 0 with usage", r.status === 0 && /usage: trantor pair/.test(r.stdout), r.stdout.slice(0, 120));
    ok("--help prints no link", !/trantor:\/\/enroll/.test(r.stdout + r.stderr));
  }

  console.log("\n[4] hub down → clear error, not a stack:");
  {
    const dead = { base: "http://127.0.0.1:1" };
    const saved = HUB; HUB = dead;
    const r = runPair(["--json", "--role", "owner"], tmp);
    HUB = saved;
    ok("unreachable hub exits 1", r.status === 1, `exit ${r.status}`);
    ok("unreachable hub error is readable", /unreachable/.test(r.stderr), r.stderr.slice(0, 200));
  }

  console.log(`\ntest-pair: ${pass} passed, ${fail} failed`);
} catch (e) {
  console.error(`harness error: ${e.stack || e}`);
  fail++;
} finally {
  if (HUB) { try { await HUB.stop(); } catch {} }
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}
process.exit(fail ? 1 : 0);

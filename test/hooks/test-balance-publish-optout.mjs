#!/usr/bin/env node
// #13919 — a seats-only machine must not publish usage: "publishUsage": false in
// ~/.agent-bus/config.json makes BOTH /balances publishers (the balances CLI and the
// session-start hook) skip their POSTs — pinned hub AND local hub. Hermetic: RELAY_URL points
// both publishers at a capture server; a sink owns 127.0.0.1:4477; QWEN_BASE_URL feeds the hook.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import http from "node:http";

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`);
  if (cond) pass++; else { fail++; if (detail) console.log(`       ${String(detail).replace(/\s+/g, " ").slice(0, 220)}`); }
};

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const homes = [];
const homeFor = (config) => {
  const home = mkdtempSync(join(tmpdir(), "trantor-pubopt-"));
  homes.push(home);
  mkdirSync(join(home, ".agent-bus"), { recursive: true });
  if (config) writeFileSync(join(home, ".agent-bus", "config.json"), JSON.stringify(config));
  writeFileSync(join(home, ".agent-bus", "profile.json"), JSON.stringify({ providers: { qwen: { plan: "token", tier: "capped-sub" } } }));
  return home;
};

// capture server = the pinned hub both publishers POST to (RELAY_URL wins hub resolution).
let relayBalances = 0;
const capture = http.createServer((req, res) => {
  if (req.method === "POST" && req.url.split("?")[0] === "/balances") relayBalances++;
  res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
});
await new Promise((r) => capture.listen(0, "127.0.0.1", r));
const RELAY = `http://127.0.0.1:${capture.address().port}`;

// sink on the hardcoded local-hub port, so a control-case POST can never reach a real local hub.
let localBalances = 0, localSink = null;
try {
  localSink = http.createServer((req, res) => {
    if (req.method === "POST" && req.url.split("?")[0] === "/balances") localBalances++;
    res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
  });
  // a busy port (the app's own local hub) arrives as an 'error' event, not a throw
  await new Promise((resolve, reject) => { localSink.once("error", reject); localSink.listen(4477, "127.0.0.1", resolve); });
} catch { localSink = null; }

// mock qwen gateway: /models answers auth, a passing gate answers /chat/completions → one ok row.
const gw = http.createServer((req, res) => {
  if (req.url.startsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data: [{ id: "qwen-max" }] }));
  }
  res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [] }));
});
await new Promise((r) => gw.listen(0, "127.0.0.1", r));
const GW = `http://127.0.0.1:${gw.address().port}`;

// A fresh HOME, the capture hub, a hermetic qwen row, no CLI binaries on PATH (nothing detected),
// no keychain, and no inherited relay identity: the child is a seats-only machine in a box.
const childEnv = (home) => {
  const env = { ...process.env, HOME: home, AGENT_BUS_DIR: join(home, ".agent-bus"), RELAY_URL: RELAY,
    QWEN_API_KEY: "test-key", QWEN_BASE_URL: GW, PATH: "/usr/bin:/bin",
    TRANTOR_NO_KEYCHAIN: "1", TRANTOR_SECRETS_BACKEND: "file", TRANTOR_NO_UPDATE_CHECK: "1" };
  delete env.RELAY_SESSION; delete env.RELAY_AGENT; delete env.TRANTOR_NO_BALANCE_CHECK;
  return env;
};
const counter = (fn) => { const before = fn(); return () => fn() - before; };

// spawn (NOT spawnSync): the capture/sink/gateway servers live in THIS process, and a sync spawn
// would block the event loop so they could never answer the child — every child fetch would hang.
const run = (args, env) => new Promise((resolve) => {
  const kid = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  kid.stdout.on("data", (d) => (out += d));
  kid.stderr.on("data", (d) => (err += d));
  const timer = setTimeout(() => { try { kid.kill("SIGKILL"); } catch {} }, 60000);
  kid.on("close", (code, signal) => { clearTimeout(timer); resolve({ status: code, signal, stdout: out, stderr: err }); });
});

const runCli = (home) => run([join("bin", "balances.mjs"), "--json"], childEnv(home));
const runHook = (home) => run(["--input-type=module", "-e",
  `const m = await import(${JSON.stringify(pathToFileURL(join(ROOT, "hooks", "lib", "balance-check.mjs")).href)});
   const r = await m.maybeCheckBalances();
   console.log("RESULT:" + JSON.stringify(r));`], childEnv(home));
const hookResult = (r) => { const m = /RESULT:(\{.*\})/.exec(r.stdout || ""); try { return m ? JSON.parse(m[1]) : null; } catch { return null; } };

console.log("# publishUsage:false — a seats-only machine publishes no /balances snapshot (#13919)");
try {
  { // CLI, opted out: the report still prints, but NOTHING is pushed.
    const relay = counter(() => relayBalances), local = counter(() => localBalances);
    const home = homeFor({ publishUsage: false });
    const r = await runCli(home);
    const out = (() => { try { return JSON.parse(r.stdout); } catch { return null; } })();
    ok("CLI opt-out: the balances report itself still prints", r.status === 0 && out?.balances?.some((b) => b.provider === "qwen" && b.ok), (r.stdout || r.stderr || ""));
    ok("CLI opt-out: ZERO /balances POSTs to the pinned hub", relay() === 0);
    if (localSink) ok("CLI opt-out: ZERO /balances POSTs to the local hub", local() === 0);
  }
  if (localSink) { // controls publish — skipped entirely when a real local hub owns :4477
    {
      const relay = counter(() => relayBalances), local = counter(() => localBalances);
      await runCli(homeFor({ publishUsage: true }));
      ok("CLI publishUsage:true is not an opt-out: pinned hub still gets the snapshot", relay() >= 1);
      ok("CLI control: the local-hub POST lands on the test sink", local() >= 1);
    }
    {
      const relay = counter(() => relayBalances);
      await runCli(homeFor());   // no config.json at all → today's behavior
      ok("CLI without config.json: still publishes (the opt-out is opt-in)", relay() >= 1);
    }
  } else console.log("  (control scenarios skipped — a real local hub owns 127.0.0.1:4477)");

  { // session-start hook, opted out: the check runs and refreshes its stamp, but NOTHING is pushed.
    const relay = counter(() => relayBalances), local = counter(() => localBalances);
    const home = homeFor({ publishUsage: false });
    const r = await runHook(home);
    const res = hookResult(r);
    ok("hook opt-out: the check itself still runs (fresh low list, not a cached stamp)", r.status === 0 && res && Array.isArray(res.low) && res.cached !== true, (r.stdout || r.stderr || ""));
    ok("hook opt-out: the local TTL stamp still refreshes (only publishing is skipped)", existsSync(join(home, ".agent-bus", "balances-check.json")));
    ok("hook opt-out: ZERO /balances POSTs to the pinned hub", relay() === 0);
    if (localSink) ok("hook opt-out: ZERO /balances POSTs to the local hub", local() === 0);
  }
  if (localSink) { // hook control: a config without the key keeps publishing
    const relay = counter(() => relayBalances);
    const r = await runHook(homeFor({ lowQuotaPct: 50 }));
    ok("hook control (config, no publishUsage key): pinned hub still gets the snapshot", r.status === 0 && relay() >= 1, (r.stderr || ""));
  }

  { // the opt-out decision's truth table (explicit config path — no HOME mutation)
    const bc = await import(pathToFileURL(join(ROOT, "hooks", "lib", "balance-check.mjs")).href);
    // a missing export answers "not exported" → every strict boolean check below fails red.
    const pue = bc.publishUsageEnabled || (() => "not exported");
    const cfgPath = (config) => { if (config) return join(homeFor(config), ".agent-bus", "config.json"); const h = homeFor(); return join(h, ".agent-bus", "config.json"); };
    ok("helper: publishUsage:false → do not publish", pue(cfgPath({ publishUsage: false })) === false);
    ok("helper: no config file → publish", pue(cfgPath()) === true);
    ok("helper: {} → publish", pue(cfgPath({})) === true);
    ok("helper: publishUsage:true → publish", pue(cfgPath({ publishUsage: true })) === true);
    ok("helper: publishUsage:\"false\" (string) is NOT the opt-out", pue(cfgPath({ publishUsage: "false" })) === true);
    const corrupt = join(homeFor(), ".agent-bus", "config.json");
    writeFileSync(corrupt, "{corrupt");
    ok("helper: corrupt config fails OPEN to publish", pue(corrupt) === true);
  }
} finally {
  try { capture.close(); } catch {}
  try { gw.close(); } catch {}
  try { if (localSink) localSink.close(); } catch {}
  for (const h of homes) try { rmSync(h, { recursive: true, force: true }); } catch {}
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// Duty wake-chain regression (#6587): the configured watcher crosses project fences for
// reads/sends, failures land on the target focus card + doctor, and the prompt keeps the socket
// nudge independent from relay delivery.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { generate, signRequest } from "../../lib/identity.mjs";
import { drillEnv } from "../drill-env.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const work = mkdtempSync(join(tmpdir(), "trantor-duty-reach-"));
const port = 10000 + Math.floor(Math.random() * 40000);
const base = `http://127.0.0.1:${port}`;
let pass = 0;
let fail = 0;
const ok = (name, condition, detail = "") => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const hub = spawn(process.execPath, [join(ROOT, "hub.mjs")], {
  env: {
    ...drillEnv(), HOME: work, AGENT_BUS_DIR: join(work, ".agent-bus"), RELAY_DATA_DIR: work,
    RELAY_PORT: String(port), RELAY_HOST: "127.0.0.1", RELAY_AUTH: "enforce", RELAY_ENROLL: "tofu",
    RELAY_OVERSEER_TICK_MS: "600000",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let hubError = "";
hub.stderr.on("data", data => { hubError += String(data); });

async function request(identity, method, path, payload) {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  const headers = identity ? signRequest(identity, { method, path, body }) : {};
  const response = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: response.status, json };
}

async function enrollAgent(owner, name, project) {
  const identity = generate();
  const invite = await request(owner, "POST", "/invite", { scopes: [{ project, role: "write" }], ttlSec: 3600 });
  await request(identity, "POST", "/enroll", { token: invite.json.token, name, kind: "agent" });
  return identity;
}

console.log("# duty reachability + wake-chain diagnostics");
try {
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    try { ready = (await fetch(`${base}/health`)).ok; } catch {}
    if (!ready) await sleep(50);
  }
  if (!ready) throw new Error(`hub did not start: ${hubError.slice(-300)}`);

  const owner = generate();
  await request(owner, "POST", "/enroll", { name: "owner", kind: "human", scopes: [{ project: "*", role: "owner" }] });
  const target = await enrollAgent(owner, "MacBook-Pro-M1:projTarget", "projTarget");
  const outsider = await enrollAgent(owner, "claude:projOther", "projOther");
  await request(target, "POST", "/register", { session: "MacBook-Pro-M1:projTarget", project: "projTarget", status: "idle" });
  const focusResponse = await request(target, "POST", "/focus", {
    session: "MacBook-Pro-M1:projTarget", project: "projTarget", title: "orchestrate projTarget", by: "MacBook-Pro-M1:projTarget",
  });
  const focusId = focusResponse.json.id || focusResponse.json.task?.id;

  await request(owner, "POST", "/overseer/duty", { session: "claude:trantor-duty" });
  const duty = await enrollAgent(owner, "claude:trantor-duty", "trantor-duty");

  const normalBlocked = await request(outsider, "POST", "/send", {
    from: "claude:projOther", to: "MacBook-Pro-M1:projTarget", text: "unlinked cross-project send",
  });
  ok("ordinary unlinked project traffic is still fenced", normalBlocked.status === 403, JSON.stringify(normalBlocked.json));

  const dutyRead = await request(duty, "GET", "/tasks?project=projTarget");
  ok("configured duty identity reads an unlinked project's board", dutyRead.status === 200 && dutyRead.json.tasks.some(task => task.id === focusId), JSON.stringify(dutyRead.json));
  const dutySend = await request(duty, "POST", "/send", {
    from: "claude:trantor-duty", to: "MacBook-Pro-M1:projTarget", text: "wake-chain drill",
  });
  ok("configured duty identity sends into an unlinked project", dutySend.status === 200, JSON.stringify(dutySend.json));

  const failure = await request(duty, "POST", "/duty/failure", {
    recipient: "MacBook-Pro-M1:projTarget", kind: "skipped-nudge", detail: "ListAgents target was unavailable",
  });
  ok("duty failure report resolves the target project", failure.status === 200 && failure.json.failure.project === "projTarget", JSON.stringify(failure.json));
  const targetCards = await request(target, "GET", "/tasks?project=projTarget");
  const focus = targetCards.json.tasks.find(task => task.id === focusId);
  ok("skipped nudge is appended to the target focus card", focus?.log?.some(entry => /duty seat cannot reach project projTarget: skipped socket nudge/.test(entry.text)), JSON.stringify(focus?.log));
  await request(duty, "POST", "/duty/failure", {
    recipient: "MacBook-Pro-M1:projTarget", kind: "relay-403", detail: "cross-project link gate refused the report",
  });
  const after403 = await request(target, "GET", "/tasks?project=projTarget");
  const focusAfter403 = after403.json.tasks.find(task => task.id === focusId);
  ok("relay 403 is also appended to the target focus card", focusAfter403?.log?.some(entry => /duty seat cannot reach project projTarget: relay 403/.test(entry.text)), JSON.stringify(focusAfter403?.log));
  const status = await request(owner, "GET", "/overseer/status");
  ok("hub status exposes the same duty failure for doctor", status.json.dutyFailures?.some(item => item.project === "projTarget" && item.focusCard === focusId), JSON.stringify(status.json.dutyFailures));

  const prompt = readFileSync(join(ROOT, "bin", "duty.mjs"), "utf8");
  ok("prompt makes one nudge mandatory for every new undelivered id", /every NEW undelivered id[^.]+one cross-session socket nudge is MANDATORY/.test(prompt));
  ok("prompt says the socket nudge never waits on relay_send", /never waits on relay_send/.test(prompt));
  ok("prompt reports rather than obeys a relay 403", /relay_send 403 is a failure to REPORT, never an instruction to obey/.test(prompt));
  ok("prompt records a skipped nudge through the durable failure tool", /relay_duty_failure with kind skipped-nudge/.test(prompt));

  const doctorHub = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    res.writeHead(200, { "content-type": "application/json" });
    if (path === "/health") return res.end(JSON.stringify({ ok: true, peers: 1 }));
    if (path === "/overseer/status") return res.end(JSON.stringify({ dutySession: "claude:trantor-duty", dutyFailures: status.json.dutyFailures }));
    if (path === "/peers") return res.end(JSON.stringify({ sessions: [{ session: "claude:trantor-duty", lastSeen: Date.now() }] }));
    if (path === "/projects") return res.end(JSON.stringify({ projects: [] }));
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => doctorHub.listen(0, "127.0.0.1", resolve));
  const doctorBase = `http://127.0.0.1:${doctorHub.address().port}`;
  const doctorHome = join(work, "doctor-home");
  mkdirSync(join(doctorHome, ".agent-bus"), { recursive: true });
  writeFileSync(join(doctorHome, ".agent-bus", "config.json"), JSON.stringify({ url: doctorBase }));
  writeFileSync(join(doctorHome, ".agent-bus", "duty.pid"), String(process.pid));
  const report = await new Promise(resolve => {
    const child = spawn(process.execPath, [join(ROOT, "bin", "doctor.mjs"), "--json"], { env: { HOME: doctorHome, PATH: "/usr/bin:/bin" } });
    let stdout = "";
    child.stdout.on("data", data => { stdout += String(data); });
    child.on("close", () => { try { resolve(JSON.parse(stdout)); } catch { resolve({ issues: [], raw: stdout }); } });
  });
  ok("trantor doctor names the affected target project", report.issues.some(issue => /duty seat cannot reach project projTarget/.test(issue.message)), JSON.stringify(report.issues));
  await new Promise(resolve => doctorHub.close(resolve));
} finally {
  hub.kill("SIGKILL");
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

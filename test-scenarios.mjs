#!/usr/bin/env node
// agent-bus scenario harness — protocol-level failure drills with MOCK agents (no LLMs, free,
// deterministic, seconds). These encode the failure modes that broke the 2026-06-09 live run,
// so they can never silently regress. Run: node test-scenarios.mjs   (part of npm test)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = 4951;
const HUB = `http://127.0.0.1:${PORT}`;
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ab-scn-"));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${detail}`); } };
const api = async (path, body) => (await fetch(HUB + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})).json();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// isolated hub: fake HOME (own bus.json), test port, 2s online cutoff so death is observable fast
const hub = spawn("node", [join(ROOT, "hub.mjs")], { env: { ...process.env, HOME: FAKE_HOME, RELAY_PORT: String(PORT), RELAY_HOST: "127.0.0.1", RELAY_ONLINE_MS: "2000" }, stdio: "ignore" });
await sleep(900);

try {
  console.log("scenario: agent registers and is honestly online");
  await api("/register", { session: "mock:proj", project: "proj", status: "working" });
  let peers = (await api("/peers")).peers;
  ok("registered agent online", peers.find(p => p.session === "mock:proj")?.online === true);

  console.log("scenario: dead agent goes visibly stale (no 5-minute green lie)");
  await sleep(2300);                                   // agent 'dies': no heartbeat
  peers = (await api("/peers")).peers;
  ok("dead agent offline after cutoff", peers.find(p => p.session === "mock:proj")?.online === false);

  console.log("scenario: runner heartbeat keeps an idle agent alive");
  const hb = (async () => { for (let i = 0; i < 3; i++) { await api(`/poll?session=hb:proj&since=0&wait=1`); } })();
  await sleep(1200);
  peers = (await api("/peers")).peers;
  ok("polling agent stays online while idle", peers.find(p => p.session === "hb:proj")?.online === true);
  await hb;

  console.log("scenario: spawn verification catches a no-show (the take-1 killer)");
  const ver = spawn("node", [join(ROOT, "bin/crew-verify.mjs"), "proj", "codex", "kimi", "--timeout", "4"], { env: { ...process.env, RELAY_URL: HUB }, stdio: ["ignore", "pipe", "ignore"] });
  let vout = ""; ver.stdout.on("data", d => (vout += d));
  await sleep(600);
  await api("/register", { session: "codex:proj", project: "proj" });   // codex comes up DURING verify; kimi never does
  const vcode = await new Promise(r => ver.on("exit", r));
  ok("verifier confirms the real agent", vout.includes("✓ codex:proj"));
  ok("verifier flags the no-show", vout.includes("✗ kimi:proj") && vout.includes("FAILED:kimi"));
  ok("verifier exits non-zero on failure", vcode === 1);

  console.log("scenario: testing gate — failed card flow");
  const { task } = await api("/task", { project: "proj", title: "widget", assignee: "kimi:proj", by: "arch" });
  for (const s of ["doing", "testing", "failed"]) await api("/task/update", { id: task.id, status: s });
  let phase = (await api("/projects")).projects.find(p => p.project === "proj")?.phase || "";
  ok("phase escalates on failure", /FAILED/.test(phase), `(got "${phase}")`);
  await api("/task/update", { id: task.id, status: "doing" });          // orchestrator bounces it
  for (const s of ["testing", "done"]) await api("/task/update", { id: task.id, status: s });
  ok("bounced card reaches done", (await api("/tasks?project=proj")).tasks.find(t => t.id === task.id)?.status === "done");
  ok("bogus status rejected", (await api("/task/update", { id: task.id, status: "yolo" })).task?.status === "done");

  console.log("scenario: lessons — record once, dedupe, scope correctly");
  await api("/lesson", { text: "never move a card to done without tests passing", scope: "global", by: "arch" });
  await api("/lesson", { text: "never move a card to done without tests passing", scope: "global", by: "arch" }); // dup
  await api("/lesson", { text: "kimi: parse the resume id from stdout", scope: "kimi", by: "arch" });
  const forKimi = (await api("/lessons?agent=kimi")).lessons;
  const forCodex = (await api("/lessons?agent=codex")).lessons;
  ok("kimi sees global + own lessons", forKimi.length === 2);
  ok("codex sees only global", forCodex.length === 1);

  console.log("scenario: messages carry their project for the dashboard lanes");
  await api("/send", { from: "kimi:proj", to: "all", text: "hello" });
  const last = (await api("/recent?limit=1")).messages.at(-1);
  ok("message stamped with project", last?.project === "proj");
} finally {
  hub.kill("SIGKILL");
  rmSync(FAKE_HOME, { recursive: true, force: true });
}

console.log(`\nscenarios: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

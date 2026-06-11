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

  console.log("scenario: difficulty + history + bounce trail");
  const { task: t2 } = await api("/task", { project: "proj", title: "hist", assignee: "kimi:proj", difficulty: "hard", by: "arch" });
  ok("difficulty stored", t2.difficulty === "hard");
  ok("creation in history", t2.history?.length === 1 && t2.history[0].to === "todo");
  for (const st of ["doing", "testing", "done"]) await api("/task/update", { id: t2.id, status: st, by: "kimi:proj" });
  await api("/task/update", { id: t2.id, status: "doing", by: "arch" });   // the bounce
  const t2b = (await api("/tasks?project=proj")).tasks.find(t => t.id === t2.id);
  const lastH = t2b.history.at(-1);
  ok("bounce recorded with attribution", lastH.from === "done" && lastH.to === "doing" && lastH.by === "arch");
  ok("bogus difficulty ignored", (await api("/task/update", { id: t2.id, difficulty: "impossible" })).task.difficulty === "hard");

  console.log("scenario: /economics shape (ledger may be absent in sandbox HOME)");
  const ec = await api("/economics");
  ok("economics responds with profile+scrooge keys", "profile" in ec && "scrooge" in ec);

  console.log("scenario: advisor — plan economics drive the mode");
  const { advise } = await import(join(ROOT, "bin/advise.mjs"));
  const world = (prof) => ({ profile: { providers: prof }, registry: { models: { "deepseek-v4-flash": { provider: "deepseek", cost_in: 0.14, cost_out: 0.28, good_for: ["code"] } }, tasks: {} }, caps: { "deepseek-v4-flash": { coding: 38 } }, agents: ["codex", "gemini", "kimi", "deepseek"], scrooge: true });
  const pk = (n, d = "medium") => Array.from({ length: n }, (_, i) => ({ title: "p" + i, difficulty: d }));
  ok("api-billed orchestrator → crew even for 2 packages",
     advise({ packages: pk(2) }, world({ claude: { tier: "api" } })).mode !== "solo");
  ok("capped-sub orchestrator → crew for 2 packages",
     ["crew", "hybrid"].includes(advise({ packages: pk(2) }, world({ claude: { tier: "capped-sub" } })).mode));
  ok("high-sub orchestrator → solo for 2 small mediums",
     advise({ packages: pk(2) }, world({ claude: { tier: "high-sub" } })).mode === "solo");
  ok("high-sub + hard packages → crew",
     advise({ packages: pk(3, "hard") }, world({ claude: { tier: "high-sub" } })).mode === "crew");
  const hy = advise({ packages: [...pk(3, "hard"), ...pk(2, "easy")] }, world({ claude: { tier: "high-sub" } }));
  ok("easy packages peel off to scrooge (hybrid)", hy.mode === "hybrid" && hy.routing.filter(r => r.executor === "scrooge").length === 2);
  ok("single easy package → scrooge inline",
     advise({ packages: pk(1, "easy") }, world({ claude: { tier: "high-sub" } })).mode === "scrooge");
  const adv = advise({ packages: pk(3, "hard") }, world({ claude: { tier: "high-sub" } }));
  ok("every route carries a reason", adv.routing.every(r => r.reason && r.reason.length > 10));
  ok("crew rationale explains seat count", /seat/.test(adv.crew.why) && adv.crew.seats > 0);
  const { task: tm } = await api("/task", { project: "proj", title: "modeled", model: "gpt-5.5", difficulty: "hard", by: "arch" });
  ok("card stores its routed model", tm.model === "gpt-5.5");
  const advA = advise({ packages: [{title:"core foundation", difficulty:"hard"}, ...pk(2,"hard")] }, world({ claude: { tier: "high-sub" } }));
  ok("foundation auto-reserves to orchestrator", advA.routing[0].executor === "orchestrator");
  ok("advisor emits markdown table", advA.routing_table_md.includes("| package |"));
  ok("advisor emits ready card_args with models", advA.card_args.every(c => c.via) && advA.card_args.filter(c => c.assignee).every(c => c.model));
  const advD = advise({ packages: [{title:"core foundation", difficulty:"hard"}, {title:"feature A", difficulty:"hard"}, {title:"integration", difficulty:"hard", owner:"self"}] }, world({ claude: { tier: "high-sub" } }));
  const integ = advD.card_args.find(c => /integration/.test(c.title));
  const feat = advD.card_args.find(c => /feature/.test(c.title));
  ok("card_args born as DAG: integration depends on all, crew depends on foundation",
     integ.deps_orders.length === 2 && JSON.stringify(feat.deps_orders) === JSON.stringify([1]));
  ok("hard packages route to frontier agents first",
     advise({ packages: pk(2, "hard") }, world({ claude: { tier: "api" } })).routing.every(r => ["codex", "gemini"].includes(r.executor)));

  console.log("scenario: deps — the flow-view edge primitive");
  const { task: dep1 } = await api("/task", { project: "proj", title: "shipv2", by: "arch" });
  const { task: dep2 } = await api("/task", { project: "proj", title: "integration v2", deps: [dep1.id, dep1.id, -3, "x"], by: "arch" });
  ok("deps dedupe + validate", JSON.stringify(dep2.deps) === JSON.stringify([dep1.id]));
  await api("/task/update", { id: dep2.id, deps: [dep1.id, dep2.id] });
  const dep2b = (await api("/tasks?project=proj")).tasks.find(t => t.id === dep2.id);
  ok("self-dep rejected on update", JSON.stringify(dep2b.deps) === JSON.stringify([dep1.id]));

  console.log("scenario: messages carry their project for the dashboard lanes");
  await api("/send", { from: "kimi:proj", to: "all", text: "hello" });
  const last = (await api("/recent?limit=1")).messages.at(-1);
  ok("message stamped with project", last?.project === "proj");
  console.log("scenario: virgin-user doctor (sandbox HOME)");
  const doc = spawn("node", [join(ROOT, "bin/doctor.mjs")], { env: { ...process.env, HOME: FAKE_HOME, RELAY_URL: HUB }, stdio: ["ignore", "pipe", "pipe"] });
  let dout = ""; doc.stdout.on("data", d => (dout += d));
  const dcode = await new Promise(r => doc.on("exit", r));
  ok("doctor exits non-zero on a virgin machine", dcode === 1);
  ok("doctor flags missing plugin with the fix", /plugin not installed/.test(dout) && /sashabogi\/trantor/.test(dout));
  ok("doctor flags unset profile", /quota profile not set/.test(dout));
  ok("doctor sees the hub", /hub up/.test(dout));
} finally {
  hub.kill("SIGKILL");
  rmSync(FAKE_HOME, { recursive: true, force: true });
}

console.log(`\nscenarios: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

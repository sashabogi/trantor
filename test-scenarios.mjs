#!/usr/bin/env node
// trantor scenario harness — protocol-level failure drills with MOCK agents (no LLMs, free,
// deterministic, seconds). These encode the failure modes that broke the 2026-06-09 live run,
// so they can never silently regress. Run: node test-scenarios.mjs   (part of npm test)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// refuse to run against a squatter: an orphaned hub on the test port would silently
// serve STALE code (spawn's EADDRINUSE dies into stdio:ignore) and poison every drill
try { await fetch(`${HUB}/health`, { signal: AbortSignal.timeout(700) }); console.error(`✗ something is already listening on :${PORT} — kill it first (lsof -ti :${PORT} | xargs kill)`); process.exit(2); } catch {}

// isolated hub: fake HOME (own bus.json), test port, 2s online cutoff so death is observable fast
const hub = spawn("node", [join(ROOT, "hub.mjs")], { env: { ...process.env, HOME: FAKE_HOME, RELAY_PORT: String(PORT), RELAY_HOST: "127.0.0.1", RELAY_ONLINE_MS: "2000", RELAY_PEER_TTL_MS: "4000" }, stdio: "ignore" });
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

  console.log("scenario: verification gates — add, dedupe, list open, resolve");
  const g1 = await api("/verify-gate", { project: "proj", claim: "Gail coefficients match published BCRAT", why: "absolute-risk calibration is risky", howToVerify: "cross-check vs the BCRA R package", by: "arch" });
  ok("gate created with an id + open status", g1.gate?.id > 0 && g1.gate.status === "open");
  const g1dup = await api("/verify-gate", { project: "proj", claim: "Gail coefficients match published BCRAT", by: "arch" });
  ok("same open claim dedupes (no duplicate gate)", g1dup.dedup === true && g1dup.gate.id === g1.gate.id);
  await api("/verify-gate", { project: "proj", claim: "colorectal matches NCI macro output", by: "arch" });
  const openGates = (await api("/verify-gates?project=proj")).gates;
  ok("two open gates listed for the project", openGates.length === 2 && openGates.every(g => g.status === "open"));
  ok("gates are project-scoped", (await api("/verify-gates?project=other")).gates.length === 0);
  const gr = await api("/verify-gate", { project: "proj", resolve: true, id: g1.gate.id, status: "verified", note: "matched BCRA to 1e-7", by: "arch" });
  ok("resolve flips status + records the note", gr.gate?.status === "verified" && gr.gate.resolvedNote.includes("1e-7"));
  ok("resolved gate drops out of the open list", (await api("/verify-gates?project=proj")).gates.length === 1);
  ok("--all includes resolved gates", (await api("/verify-gates?project=proj&all=1")).gates.length === 2);
  ok("resolving an unknown id errors", (await api("/verify-gate", { project: "proj", resolve: true, id: 99999 })).error != null);
  ok("a claimless add is rejected", (await api("/verify-gate", { project: "proj", by: "arch" })).error != null);

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

  console.log("scenario: /learning shape (lessons + per-LLM reliability + baked-in guardrails)");
  await api("/lesson", { text: "end your turn when done", scope: "global", by: "host:proj" });
  await api("/lesson", { text: "kimi: avoid huge diffs", scope: "kimi", by: "kimi:proj" });
  const lr = await api("/learning");
  ok("learning responds with totals+lessons+agents+models keys",
     "totals" in lr && "lessons" in lr && Array.isArray(lr.agents) && Array.isArray(lr.models));
  ok("learning groups lessons (global array + per-agent + per-project)",
     Array.isArray(lr.lessons.global) && lr.lessons.global.length >= 1 &&
     Array.isArray(lr.lessons.byAgent.kimi) && lr.lessons.byProject.proj);
  ok("learning totals.lessons counts recorded lessons", lr.totals.lessons >= 2);
  ok("learning exposes per-project reliability/guardrail maps (not just global aggregates)",
     lr.agentsByProject && typeof lr.agentsByProject === "object" &&
     lr.modelsByProject && typeof lr.modelsByProject === "object");

  console.log("scenario: advisor — plan economics drive the mode");
  const { advise } = await import(join(ROOT, "bin/advise.mjs"));
  const world = (prof) => ({ profile: { providers: prof }, registry: { models: { "deepseek-v4-flash": { provider: "deepseek", cost_in: 0.14, cost_out: 0.28, good_for: ["code"] } }, tasks: {} }, caps: { "deepseek-v4-flash": { coding: 38 } }, agents: ["codex", "glm", "kimi", "deepseek"], scrooge: true });
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
     advise({ packages: pk(2, "hard") }, world({ claude: { tier: "api" } })).routing.every(r => ["codex", "glm"].includes(r.executor)));
  ok("retired gemini is never an available crew seat",
     !advise({ packages: pk(3, "hard") }, world({ claude: { tier: "api" } })).routing.some(r => r.executor === "gemini"));
  ok("glm card carries its own glm:zai-coding-plan launch + glm session",
     advise({ packages: pk(4, "hard") }, world({ claude: { tier: "api" } })).card_args.some(c => c.launch === "glm:zai-coding-plan" && c.assignee === "glm:<project>"));
  // BYOM: a user who brought ONLY an OpenRouter key — every seat is openrouter, distinct bus identity.
  const orOnly = (prof) => ({ ...world(prof), agents: ["openrouter"] });
  const advOR = advise({ packages: pk(2, "hard") }, orOnly({ claude: { tier: "api" } }));
  ok("openrouter-only user routes all work to the openrouter seat",
     advOR.card_args.filter(c => c.assignee).every(c => c.launch === "openrouter:openrouter" && c.assignee === "openrouter:<project>"));
  ok("openrouter seat has its own session, distinct from the glm seat",
     advOR.card_args.filter(c => c.assignee).every(c => c.assignee === "openrouter:<project>" && c.assignee !== "glm:<project>"));
  ok("openrouter hard route points at scrooge-capabilities (catalog scoring) or pinning",
     advOR.routing.some(r => /scrooge-capabilities/.test(r.reason) && /pin/i.test(r.reason)));
  ok("openrouter sits last → native seats win hard work first",
     advise({ packages: pk(2, "hard") }, world({ claude: { tier: "api" } })).routing.every(r => r.executor !== "openrouter"));
  // T3 BYOM: the roster DERIVES from config — a brought opencode provider becomes a seat, no code change.
  const { buildRoster, discoverSeats } = await import(join(ROOT, "bin/advise.mjs"));
  const brought = discoverSeats({ providers: { inception: { plan: "api", tier: "api" } } },
                                { provider: { inception: { options: { apiKey: "x" } }, "zai-coding-plan": {} } });
  ok("a brought opencode provider becomes a discovered seat (own launch + session)",
     brought.inception?.discovered && brought.inception.launch === "inception:inception" && brought.inception.session === "inception");
  ok("discovery never duplicates a built-in opencode provider (zai-coding-plan → glm)",
     !brought["zai-coding-plan"] && !brought.glm);
  ok("discovery skips native CLIs / built-in aliases",
     Object.keys(discoverSeats({ providers: { codex: {}, zai: {}, claude: {} } }, {})).length === 0);
  const fullRoster = buildRoster({ providers: { inception: { tier: "api" } } }, { provider: { inception: { options: { apiKey: "x" } } } });
  ok("buildRoster merges built-ins + brought", !!(fullRoster.codex && fullRoster.glm && fullRoster.inception));
  const advB = advise({ packages: pk(2, "hard") }, { ...world({ claude: { tier: "api" } }), roster: fullRoster, agents: ["inception"] });
  ok("advise routes work to a brought provider under its own session",
     advB.card_args.filter(c => c.assignee).every(c => c.assignee === "inception:<project>" && c.launch === "inception:inception"));
  ok("a brought provider never collides with a built-in session (glm/openrouter/deepseek)",
     advB.card_args.filter(c => c.assignee).every(c => !["glm:<project>", "openrouter:<project>", "deepseek:<project>"].includes(c.assignee)));
  ok("glm now has its own bus label (not the generic opencode session)",
     buildRoster({}, {}).glm.session === "glm" && buildRoster({}, {}).glm.launch === "glm:zai-coding-plan");
  // custom-endpoint wiring: provider add --base-url writes a valid opencode.json provider block
  const { wireOpencodeProvider } = await import(join(ROOT, "bin/provider.mjs"));
  const tmpCfg = join(ROOT, ".test-opencode.json");
  try {
    wireOpencodeProvider("acme", "https://api.acme.ai/v1", ["acme-large", "acme-mini"], tmpCfg);
    const wrote = JSON.parse((await import("node:fs")).readFileSync(tmpCfg, "utf8"));
    ok("custom endpoint → valid opencode provider block (npm + baseURL + env-keyed apiKey + models)",
       wrote.provider.acme.npm === "@ai-sdk/openai-compatible" &&
       wrote.provider.acme.options.baseURL === "https://api.acme.ai/v1" &&
       wrote.provider.acme.options.apiKey === "{env:ACME_API_KEY}" &&
       Object.keys(wrote.provider.acme.models).length === 2);
    // a second provider merges, never clobbers
    wireOpencodeProvider("beta", "https://api.beta.ai/v1", [], tmpCfg);
    const merged = JSON.parse((await import("node:fs")).readFileSync(tmpCfg, "utf8"));
    ok("wiring a second custom provider preserves the first (merge, no clobber)",
       merged.provider.acme && merged.provider.beta);
  } finally { try { (await import("node:fs")).unlinkSync(tmpCfg); } catch {} }

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

  console.log("scenario: /project/delete forgets a dead project (cards, peers, brief, lane)");
  await api("/register", { session: "ghost:zombieproj", project: "zombieproj", status: "abandoned" });
  await api("/task", { project: "zombieproj", title: "stale work", by: "ghost:zombieproj", status: "doing" });
  await api("/project", { project: "zombieproj", brief: "a project nobody closed", by: "ghost:zombieproj" });
  await api("/send", { from: "ghost:zombieproj", to: "all", text: "last words", project: "zombieproj" });
  let zdel = await api("/project/delete", { project: "zombieproj" });
  ok("delete reports what it removed", zdel.ok === true && zdel.removed.tasks === 1 && zdel.removed.peers === 1 && zdel.removed.messages >= 1);
  const zprojects = (await api("/projects")).projects.map(p => p.project);
  ok("forgotten project gone from /projects", !zprojects.includes("zombieproj"));
  ok("other projects untouched by the delete", zprojects.includes("proj"));
  ok("its cards are gone too", !(await api("/tasks?project=zombieproj")).tasks.length);
  await api("/register", { session: "ghost:zombieproj", project: "zombieproj", status: "back" });
  ok("project returns cleanly when an agent re-registers", (await api("/projects")).projects.some(p => p.project === "zombieproj"));
  await api("/project/delete", { project: "zombieproj" });   // re-forget; leave state clean for later drills

  console.log("scenario: virgin-user doctor (sandbox HOME)");
  const doc = spawn("node", [join(ROOT, "bin/doctor.mjs")], { env: { ...process.env, HOME: FAKE_HOME, RELAY_URL: HUB }, stdio: ["ignore", "pipe", "pipe"] });
  let dout = ""; doc.stdout.on("data", d => (dout += d));
  const dcode = await new Promise(r => doc.on("exit", r));
  ok("doctor exits non-zero on a virgin machine", dcode === 1);
  ok("doctor flags missing plugin with the fix", /plugin not installed/.test(dout) && /sashabogi\/trantor/.test(dout));
  ok("doctor flags unset profile", /quota profile not set/.test(dout));
  ok("doctor sees the hub", /hub up/.test(dout));
  console.log("scenario: prune — old peers vanish but their project cards survive");
  await api("/register", { session: "oldie:prune-proj", project: "prune-proj", status: "idle" });
  const { task: ptask } = await api("/task", { project: "prune-proj", title: "survivor", by: "oldie:prune-proj" });
  let pBefore = (await api("/peers")).peers;
  ok("prune-target peer is present before TTL", pBefore.some(p => p.session === "oldie:prune-proj"));
  await sleep(5000);                                    // past RELAY_PEER_TTL_MS=4000
  let pAfter = (await api("/peers")).peers;             // /peers triggers opportunistic prune
  ok("prune-target peer removed from /peers after TTL", !pAfter.some(p => p.session === "oldie:prune-proj"));
  ok("prune project cards survive purge", (await api("/tasks?project=prune-proj")).tasks.some(t => t.id === ptask.id));

  console.log("scenario: /history — card create+move produces chronological events with correct from/to/by");
  const { task: ht } = await api("/task", { project: "proj", title: "timeline-test", by: "arch" });
  for (const st of ["doing", "testing", "done"]) await api("/task/update", { id: ht.id, status: st, by: "kimi:proj" });
  const hist = (await api("/history?project=proj")).events;
  const hEvents = hist.filter(e => e.taskId === ht.id);
  ok("/history returns events in chronological order", hEvents.length >= 2 && hEvents[0].ts <= hEvents[1].ts);
  ok("created event has to=todo and by=arch", hEvents[0].type === "created" && hEvents[0].to === "todo" && hEvents[0].by === "arch");
  const moved = hEvents.find(e => e.type === "moved" && e.from === "doing" && e.to === "testing");
  ok("moved event has correct from, to, by", moved && moved.by === "kimi:proj");
  const finalMove = hEvents.find(e => e.type === "moved" && e.to === "done");
  ok("final move to done present", finalMove && finalMove.by === "kimi:proj");

  console.log("scenario: cardEvents backfill — a hub booting with legacy task.history (no cardEvents) reconstructs /history");
  {
    const BHOME = mkdtempSync(join(tmpdir(), "ab-bf-"));
    const seeded = { messages: [], peers: {}, seq: 0, taskSeq: 1, projectMeta: {}, lessons: [],
      tasks: [{ id: 1, project: "legacy", title: "old card", status: "done", assignee: "kimi:legacy", difficulty: "hard", by: "arch", ts: 1000, updated: 3000,
        history: [{ to: "todo", by: "arch", ts: 1000 }, { from: "todo", to: "doing", by: "kimi:legacy", ts: 2000 }, { from: "doing", to: "done", by: "kimi:legacy", ts: 3000 }] }] };
    writeFileSync(join(BHOME, "bus.json"), JSON.stringify(seeded));
    const BPORT = 4952;
    const bh = spawn("node", [join(ROOT, "hub.mjs")], { env: { ...process.env, HOME: BHOME, RELAY_DATA_DIR: BHOME, RELAY_PORT: String(BPORT), RELAY_HOST: "127.0.0.1" }, stdio: "ignore" });
    await sleep(900);
    const bev = (await (await fetch(`http://127.0.0.1:${BPORT}/history?project=legacy`)).json()).events;
    ok("backfill reconstructed all 3 legacy history entries", bev.length === 3);
    ok("backfill first event is created->todo", bev[0]?.type === "created" && bev[0]?.to === "todo");
    ok("backfill rebuilds moves chronologically with from/to/by", bev[1]?.type === "moved" && bev[1]?.from === "todo" && bev[1]?.to === "doing" && bev[1]?.by === "kimi:legacy" && bev[2]?.to === "done");
    bh.kill("SIGKILL"); rmSync(BHOME, { recursive: true, force: true });
  }

  console.log("scenario: /todos — a session's TodoWrite list mirrors onto its board as cards");
  await api("/todos", { session: "host:tp", project: "tp", todos: [
    { content: "design schema", status: "completed" },
    { content: "write handler", status: "in_progress" },
    { content: "add tests", status: "pending" }] });
  let tcards = (await api("/tasks?project=tp")).tasks.filter(t => t.source === "todo");
  ok("todo sync creates a card per todo", tcards.length === 3);
  ok("status maps pending/in_progress/completed -> todo/doing/done",
     tcards.find(c => c.todoKey === "design schema")?.status === "done" &&
     tcards.find(c => c.todoKey === "write handler")?.status === "doing" &&
     tcards.find(c => c.todoKey === "add tests")?.status === "todo");
  await api("/todos", { session: "host:tp", project: "tp", todos: [
    { content: "design schema", status: "completed" },
    { content: "write handler", status: "completed" },
    { content: "add tests", status: "in_progress" }] });
  tcards = (await api("/tasks?project=tp")).tasks.filter(t => t.source === "todo");
  ok("a changed todo moves its card (stable card, not a dup)", tcards.length === 3 &&
     tcards.find(c => c.todoKey === "write handler")?.status === "done" &&
     tcards.find(c => c.todoKey === "add tests")?.status === "doing");
  await api("/todos", { session: "host:tp", project: "tp", todos: [
    { content: "design schema", status: "completed" },
    { content: "write handler", status: "completed" }] });
  tcards = (await api("/tasks?project=tp")).tasks.filter(t => t.source === "todo");
  ok("a dropped non-done todo's card is removed", !tcards.find(c => c.todoKey === "add tests"));
  ok("done cards stay on the board (accomplished work)", tcards.filter(c => c.status === "done").length === 2);
  ok("/history captured the todo card lifecycle", (await api("/history?project=tp")).events.some(e => e.title === "add tests"));

  console.log("scenario: /card detail — the card + its status events + ONLY the bus reports referencing #id");
  const { task: ct } = await api("/task", { project: "cardproj", title: "build the widget", assignee: "codex:cardproj", by: "arch" });
  await api("/task/update", { id: ct.id, status: "doing", by: "codex:cardproj" });
  await api("/send", { from: "codex:cardproj", to: "all", text: `#${ct.id} doing: building the widget now`, project: "cardproj" });
  await api("/send", { from: "x:cardproj", to: "all", text: `unrelated #${ct.id}0 chatter`, project: "cardproj" });   // #id0 must NOT match #id
  const cd = await api(`/card?id=${ct.id}`);
  ok("card detail returns the task", cd.task && cd.task.id === ct.id && cd.task.title === "build the widget");
  ok("card detail includes its status events (created + move)", cd.events.length >= 2 && cd.events[0].type === "created");
  ok("card detail matches only #id reports (word boundary, not #id0)", cd.messages.length === 1 && /doing: building/.test(cd.messages[0].text));

  console.log("scenario: canonical project identity — one repo = one lane (no fragmentation)");
  // reproduce the bug: a host lane and a crew lane for the SAME project under different keys
  await api("/task", { project: "myapp.ai", title: "host card", by: "host:myapp.ai" });
  await api("/task", { project: "myapp", title: "crew card", by: "codex:myapp" });
  await api("/register", { session: "codex:myapp", project: "myapp", status: "building" });
  const projsBefore = (await api("/projects")).projects.map(p => p.project);
  ok("both lanes exist before merge", projsBefore.includes("myapp") && projsBefore.includes("myapp.ai"));
  const mg = await api("/project/merge", { from: "myapp", to: "myapp.ai" });
  ok("merge reports cards+peers moved", mg.ok && mg.moved.cards >= 1 && mg.moved.peers >= 1);
  const projsAfter = (await api("/projects")).projects.map(p => p.project);
  ok("the 'myapp' lane is gone after merge", !projsAfter.includes("myapp") && projsAfter.includes("myapp.ai"));
  const merged = (await api("/tasks?project=myapp.ai")).tasks.map(t => t.title);
  ok("both cards now live on the canonical lane", merged.includes("host card") && merged.includes("crew card"));
  ok("querying the OLD key folds in via alias", (await api("/tasks?project=myapp")).tasks.length === merged.length);
  await api("/task", { project: "myapp", title: "post-merge crew card", by: "kimi:myapp" });
  ok("a NEW card under the old key lands on the canonical lane", (await api("/tasks?project=myapp.ai")).tasks.some(t => t.title === "post-merge crew card"));
  const peerCanon = (await api("/peers")).peers.find(p => p.session === "codex:myapp");
  ok("a peer under the old key shows the canonical project", peerCanon && peerCanon.project === "myapp.ai");

  console.log("scenario: /catchup — a fresh session's view of the continuous board");
  await api("/project", { project: "myapp.ai", brief: "the north star" });
  await api("/task/update", { id: (await api("/tasks?project=myapp.ai")).tasks.find(t => t.title === "host card").id, status: "doing", by: "host:myapp.ai" });
  const cu = await api("/catchup?project=myapp.ai");
  ok("catchup returns the brief", cu.brief === "the north star");
  ok("catchup counts cards by status", cu.total >= 3 && cu.counts.doing >= 1);
  ok("catchup lists in-progress work", cu.doing.some(t => t.title === "host card"));
  ok("catchup accepts the aliased key too", (await api("/catchup?project=myapp")).project === "myapp.ai");

  console.log("scenario: /phases — FLOW v2 orchestrator-rooted phase derivation (title-prefix + time)");
  await api("/task", { project: "flowproj", title: "P1a backend schema", assignee: "codex:flowproj", by: "host:flowproj" });
  await api("/task", { project: "flowproj", title: "P1b frontend", assignee: "gemini:flowproj", by: "host:flowproj" });
  await api("/task", { project: "flowproj", title: "P2 wire it up", assignee: "kimi:flowproj", by: "host:flowproj" });
  await api("/task", { project: "flowproj", title: "CBv2-1 cost book layout", assignee: "deepseek:flowproj", by: "host:flowproj" });
  await api("/task", { project: "flowproj", title: "audit the existing code", assignee: "host:flowproj", by: "host:flowproj" }); // misc → Setup, orchestrator-owned
  const ph = await api("/phases?project=flowproj");
  const labels = ph.phases.map(p => p.label);
  ok("phases group P1a+P1b into one P1 phase", ph.phases.find(p => p.label === "P1")?.total === 2);
  ok("P-prefix, CB and a misc Setup phase all derived", labels.includes("P1") && labels.includes("P2") && labels.includes("CB") && labels.some(l => /^Setup/.test(l)));
  ok("every card lands in exactly one phase (no blob, no loss)", ph.phases.reduce((s, p) => s + p.total, 0) === 5);
  ok("crew vs orchestrator split per phase", ph.phases.find(p => p.label === "P1").crew.length === 2 && ph.phases.find(p => /^Setup/.test(p.label)).orchestrators.length === 1);
  ok("a P1 node carries its agent brand + status for the flowchart", ph.phases.find(p => p.label === "P1").crew.every(n => n.agent && n.status));
  ok("phases ordered by first-seen time", ph.phases.every((p, i, a) => i === 0 || a[i - 1].start <= p.start));
  ok("a phase carries a derived THEME from its card titles (not just the token)", /backend|frontend/i.test(ph.phases.find(p => p.label === "P1").theme || ""));
  // an explicit phase tag wins over title-prefix inference
  await api("/task", { project: "flowproj", title: "ship the thing", phase: "Launch", assignee: "codex:flowproj", by: "host:flowproj" });
  const ph2 = await api("/phases?project=flowproj");
  ok("an explicit phase tag groups the card under that phase", ph2.phases.find(p => p.label === "Launch")?.total === 1);
  // an explicit phase GOAL overrides the derived theme in the header
  await api("/phase", { project: "flowproj", phase: "P1", goal: "stand up the backend + UI" });
  const ph3 = await api("/phases?project=flowproj");
  ok("POST /phase sets an explicit goal returned by /phases", ph3.phases.find(p => p.label === "P1")?.goal === "stand up the backend + UI");
  // git-backfill: a card created with a HISTORICAL ts (past commit time) keeps that ts (not now())
  const past = 1700000000000; // 2023 — clearly historical
  const { task: gt } = await api("/task", { project: "backfillproj", title: "scaffold: initial", status: "done", ts: past, source: "git", by: "host:backfillproj" });
  ok("a backfilled card keeps its historical ts (not now)", gt.ts === past && gt.history[0].ts === past);
  ok("a backfilled card records its source provenance", gt.source === "git");
  const { task: nowCard } = await api("/task", { project: "backfillproj", title: "live one", ts: Date.now() + 1e10, by: "host:backfillproj" });
  ok("a bogus/future ts is ignored → card gets now()", Math.abs(Date.now() - nowCard.ts) < 60000);

  console.log("scenario: sub-agent cost — notional pricing math + the hub stores costKind/costUsd/tokens");
  const { costOfTurn, notionalCost, tierFor } = await import("./hooks/pricing.mjs");
  ok("pricing: opus 1M in + 1M out = $30", costOfTurn({ model: "claude-opus-4-8", input: 1e6, output: 1e6 }) === 30);
  ok("pricing: sonnet cache-read 1M = $0.30 (0.1x input)", Math.abs(costOfTurn({ model: "claude-sonnet-4-6", cacheRead: 1e6 }) - 0.3) < 1e-9);
  ok("pricing: cache-write defaults to 5m (haiku 1M = $1.25)", Math.abs(costOfTurn({ model: "claude-haiku-4-5", cacheWrite: 1e6 }) - 1.25) < 1e-9);
  ok("pricing: unknown model → null (never fabricate)", costOfTurn({ model: "gpt-5", input: 1e6 }) === null && tierFor("gpt-5") === null);
  const nc = notionalCost([{ model: "claude-opus-4-8", input: 1000, output: 500 }, { model: "gpt-5", input: 999 }]);
  ok("notionalCost sums priced rows + counts unpriced (no fabrication)", nc.usd > 0 && nc.unpriced === 1 && nc.tokens.input === 1999);
  const { task: sc } = await api("/task", { project: "ccproj", title: "claude-code-guide: research hooks", status: "done",
    assignee: "claude-code-guide:ccproj", source: "cc-subagent", costKind: "subagent-notional", costUsd: 1.2345,
    model: "claude-sonnet-4-6", effort: "medium", tokens: { input: 26, output: 7616, cacheWrite: 209810, cacheRead: 1016405 }, by: "host:ccproj" });
  ok("hub stores costKind + costUsd on the card", sc.costKind === "subagent-notional" && sc.costUsd === 1.2345);
  ok("hub stores the token breakdown", sc.tokens && sc.tokens.cacheRead === 1016405 && sc.source === "cc-subagent");
  // a second notional card + a (notional-irrelevant) scrooge stays SEPARATE — /economics never mixes them
  await api("/task", { project: "ccproj", title: "Explore: map the repo", status: "done", assignee: "Explore:ccproj",
    source: "cc-subagent", costKind: "subagent-notional", costUsd: 0.5, model: "claude-haiku-4-5", tokens: { input: 10, output: 100, cacheWrite: 0, cacheRead: 0 }, by: "host:ccproj" });
  const eco = await api("/economics");
  const life = eco.costKinds && eco.costKinds.lifetime && eco.costKinds.lifetime["subagent-notional"];
  ok("/economics rolls up subagent-notional cost across cards", life && Math.abs(life.usd - 1.7345) < 1e-6 && life.count === 2);
  ok("/economics scopes notional per project", eco.notionalByProject && Math.abs(eco.notionalByProject["ccproj"] - 1.7345) < 1e-6);
  ok("notional rollup is its OWN bucket, not folded into scrooge real-spend", !("subagent-notional" in (eco.scrooge?.by_model || {})));

} finally {
  hub.kill("SIGKILL");
  rmSync(FAKE_HOME, { recursive: true, force: true });
}

console.log(`\nscenarios: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// trantor overseer e2e tests — autonomy levels, collision detection, narration, verify gates.
//
// The overseer detects collisions MECHANICALLY (lib/overseer.mjs) and the LLM only narrates
// (bin/overseer-narrate.mjs). Level 1 = observe, level 2 = warn, level 3 = gate.
//
// Kept honest here:
//   1. /policy defaults + set autonomy/links, GET round-trip
//   2. overseer tick emits overseer.warn events at ANY level
//   3. same-project-sessions + file-conflict kinds both work
//   4. level 1 still logs events; /overseer/context.warnings is populated
//   5. level 3+file-conflict opens a verify gate
//   6. POST /overseer/narrate marks an event narrated
//   7. all endpoints survive missing _overseer module (hub runs without it)
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "./drill-env.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${name}`); };

function spawnHub(port, extraEnv = {}, dir = mkdtempSync(join(tmpdir(), "trantor-overseer-"))) {
  mkdirSync(join(dir, ".agent-bus"), { recursive: true });
  const hub = spawn("node", [join(ROOT, "hub.mjs")], {
    env: { ...drillEnv(), RELAY_DATA_DIR: dir, HOME: dir, RELAY_PORT: String(port), PORT: String(port),
           TRANTOR_NO_UPDATE_CHECK: "1", RELAY_AUTH: "off", RELAY_OVERSEER_TICK_MS: "1000", ...extraEnv },
    stdio: ["ignore", "ignore", "pipe"],
  });
  hub._dir = dir;
  return hub;
}
const mk = (base) => ({
  post: (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json()),
  get: (p) => fetch(base + p).then(r => r.json()),
});

console.log("# trantor overseer e2e tests");

// ── /policy defaults + set/get round-trip ─────────────────────────────────────────────────────
const PA = 47931, hubA = spawnHub(PA);
await sleep(800);
try {
  const A = mk(`http://127.0.0.1:${PA}`);
  const def = await A.get("/policy");
  ok(def.autonomy && def.autonomy["*"] === 1 && Array.isArray(def.links) && def.links.length === 0,
     "GET /policy default {autonomy:{'*':1},links:[]}");

  const s1 = await A.post("/policy", { autonomy: { alpha: 3, beta: 2 } });
  ok(s1.ok === true, "POST /policy set autonomy -> ok");
  const a1 = await A.get("/policy");
  ok(a1.autonomy?.alpha === 3 && a1.autonomy?.beta === 2 && a1.autonomy?.["*"] === 1,
     "policy persists autonomy across GET");

  const s2 = await A.post("/policy", { link: { projects: ["alpha", "charlie"], reason: "codependent microservices" } });
  ok(s2.ok === true, "POST /policy add link -> ok");
  const a2 = await A.get("/policy");
  ok(a2.links?.some(l => (l.projects || []).includes("alpha") && (l.projects || []).includes("charlie")),
     "link persists across GET");
} catch (e) { fail++; console.log(`  ✗ /policy: ${e.message}`); }
finally { hubA.kill(); }

// ── overseer tick: same-project-sessions at level>=2 ───────────────────────────────────────────
const PB = 47932, hubB = spawnHub(PB);
await sleep(1500);
try {
  const B = mk(`http://127.0.0.1:${PB}`);
  await B.post("/policy", { autonomy: { alpha: 2 } });
  await B.post("/register", { session: "host:alpha", project: "alpha", status: "orchestrating" });
  await B.post("/register", { session: "codex:alpha", project: "alpha", status: "ready" });
  await sleep(2500);
  const ev = await B.get("/events?type=overseer.&limit=10");
  const warns = (ev.events ?? []).filter(e => e.type === "overseer.warn" && e.kind === "same-project-sessions");
  ok(warns.length >= 1, `overseer.warn same-project-sessions emitted (got ${warns.length})`);
} catch (e) { fail++; console.log(`  ✗ tick same-project: ${e.message}`); }
finally { hubB.kill(); }

// ── file-conflict from /claim ──────────────────────────────────────────────────────────────────
const PC = 47933, hubC = spawnHub(PC);
await sleep(1500);
try {
  const C = mk(`http://127.0.0.1:${PC}`);
  await C.post("/policy", { autonomy: { alpha: 2 } });
  await C.post("/register", { session: "host:alpha", project: "alpha" });
  await C.post("/register", { session: "codex:alpha", project: "alpha" });
  await C.post("/claim", { project: "alpha", file: "src/a.ts", session: "host:alpha" });
  await C.post("/claim", { project: "alpha", file: "src/a.ts", session: "codex:alpha" });
  await sleep(2500);
  const ev = await C.get("/events?type=overseer.&limit=10");
  const warns = (ev.events ?? []).filter(e => e.type === "overseer.warn" && e.kind === "file-conflict");
  ok(warns.length >= 1, `overseer.warn file-conflict emitted (got ${warns.length})`);
} catch (e) { fail++; console.log(`  ✗ tick file-conflict: ${e.message}`); }
finally { hubC.kill(); }

// ── level 1: events still logged, /overseer/context.warnings populated ──────────────────────────
const PD = 47934, hubD = spawnHub(PD);
await sleep(1500);
try {
  const D = mk(`http://127.0.0.1:${PD}`);
  await D.post("/policy", { autonomy: { alpha: 1 } });
  await D.post("/register", { session: "host:alpha", project: "alpha" });
  await D.post("/register", { session: "codex:alpha", project: "alpha" });
  await sleep(2500);
  const ev = await D.get("/events?type=overseer.&limit=10");
  ok((ev.events ?? []).some(e => e.type === "overseer.warn"),
     "level 1: overseer.warn events still logged (observe)");
  const ctx = await D.get("/overseer/context?project=alpha");
  ok(ctx.level === 1, "level 1: context.level is 1");
  ok(Array.isArray(ctx.warnings) && ctx.warnings.length >= 1,
     "level 1: /overseer/context.warnings populated");
} catch (e) { fail++; console.log(`  ✗ level 1: ${e.message}`); }
finally { hubD.kill(); }

// ── level 3 + file-conflict -> verify gate ─────────────────────────────────────────────────────
const PE = 47935, hubE = spawnHub(PE);
await sleep(1500);
try {
  const E = mk(`http://127.0.0.1:${PE}`);
  await E.post("/policy", { autonomy: { alpha: 3 } });
  await E.post("/register", { session: "host:alpha", project: "alpha" });
  await E.post("/register", { session: "codex:alpha", project: "alpha" });
  await E.post("/claim", { project: "alpha", file: "src/x.ts", session: "host:alpha" });
  await E.post("/claim", { project: "alpha", file: "src/x.ts", session: "codex:alpha" });
  await sleep(2500);
  const gates = await E.get("/verify-gates?project=alpha");
  ok((gates.gates ?? []).some(g => g.status === "open" && g.by === "overseer"),
     "level 3 + file-conflict: verify gate opened");
  const gateEv = await E.get("/events?type=verify.gate.");
  ok((gateEv.events ?? []).some(e => e.type === "verify.gate.opened"),
     "verify.gate.opened event logged");
} catch (e) { fail++; console.log(`  ✗ level 3 gate: ${e.message}`); }
finally { hubE.kill(); }

// ── POST /overseer/narrate marks event narrated ────────────────────────────────────────────────
const PF = 47936, hubF = spawnHub(PF);
await sleep(1500);
try {
  const F = mk(`http://127.0.0.1:${PF}`);
  await F.post("/policy", { autonomy: { alpha: 2 } });
  await F.post("/register", { session: "host:alpha", project: "alpha" });
  await F.post("/register", { session: "codex:alpha", project: "alpha" });
  await sleep(2500);
  const ev = await F.get("/events?type=overseer.&limit=10");
  const warn = (ev.events ?? []).find(e => e.type === "overseer.warn");
  ok(Boolean(warn), "overseer.warn event exists for narration test");
  if (warn) {
    const nar = await F.post("/overseer/narrate", { eventId: warn.id, text: "Coordinate over the bus before editing." });
    ok(nar.ok === true, "POST /overseer/narrate -> ok");
    const ev2 = await F.get("/events?type=overseer.&limit=10");
    const updated = (ev2.events ?? []).find(e => e.id === warn.id);
    ok(updated?.narrated === true && updated?.narration === "Coordinate over the bus before editing.",
       "event marked narrated=true after POST /overseer/narrate");
  }
} catch (e) { fail++; console.log(`  ✗ narrate: ${e.message}`); }
finally { hubF.kill(); }

// ── EPISODES, not a metronome (regression 2026-08-12) ──────────────────────────────────────────
// A collision is a STATE. The old code cleared its dedup map on a timer, so a standing condition
// re-fired every window forever — 500 events for 4 distinct conditions in 8 days, each one also
// waking the duty seat for a full turn. A held condition must warn EXACTLY ONCE, and must be able
// to fire again only after it has genuinely cleared.
const PG = 47937, hubG = spawnHub(PG, {
  RELAY_OVERSEER_TICK_MS: "300", RELAY_OVERSEER_CLEAR_MS: "2500",
  RELAY_OVERSEER_PEER_LIVE_MS: "2500",  // so the condition can actually go away inside a test —
  // but with margin: the original 800ms window was narrower than an event-loop stall on a loaded
  // machine, so a stretched heartbeat FLAPPED the condition and the hub (correctly, per its own
  // contract) opened a fresh episode. "got 2/3/4 warns" tracked machine load exactly (#4854 family).
});
await sleep(1500);
try {
  const G = mk(`http://127.0.0.1:${PG}`);
  await G.post("/policy", { autonomy: { alpha: 2 } });
  // Keep the condition CONTINUOUSLY true across many ticks by re-registering (fresh heartbeats).
  // Both sessions beat CONCURRENTLY on an interval, not via sequential awaits — one slow HTTP
  // round-trip must not delay the other session's heartbeat past the liveness window.
  const beat = setInterval(() => {
    G.post("/register", { session: "host:alpha", project: "alpha" }).catch(() => {});
    G.post("/register", { session: "codex:alpha", project: "alpha" }).catch(() => {});
  }, 150);
  await sleep(3000);
  clearInterval(beat);
  const ev = await G.get("/events?type=overseer.&limit=100");
  const warns = (ev.events ?? []).filter(e => e.type === "overseer.warn");
  ok(warns.length === 1, `standing condition warns ONCE across ~10 ticks (got ${warns.length})`);

  const st = await G.get("/overseer/status");
  ok(st.standing >= 1, "status reports the condition as standing");
  ok(Number(st.warnings?.[0]?.since) > 0, "live detection carries `since` (a duration, not just a fact)");

  // Let it clear (no heartbeats past CLEAR_MS), then bring it back: a genuine recurrence re-warns.
  await sleep(6200);
  await G.post("/register", { session: "host:alpha", project: "alpha" });
  await G.post("/register", { session: "codex:alpha", project: "alpha" });
  await sleep(1200);
  const ev2 = await G.get("/events?type=overseer.&limit=100");
  const warns2 = (ev2.events ?? []).filter(e => e.type === "overseer.warn");
  ok(warns2.length === 2, `a recurrence AFTER the condition cleared warns again (got ${warns2.length})`);
} catch (e) { fail++; console.log(`  ✗ episodes: ${e.message}`); }
finally { hubG.kill(); }

// ── EPISODE IDENTITY is the condition, not the membership (fixes #5350) ────────────────────────
// The episode key included the session list, so a seat bouncing in and out of a STANDING collision
// minted a new episode per membership permutation: a new warn, another duty wake, another round of
// party intros — churn proportional to how often seats come and go, not to how often conditions
// actually start. The episode must be the CONDITION (project+kind+files): membership volatility
// holds the existing episode; only a genuine clear-then-recur may warn again.
const PH = 47938, hubH = spawnHub(PH, {
  RELAY_OVERSEER_TICK_MS: "300", RELAY_OVERSEER_CLEAR_MS: "1500", RELAY_OVERSEER_PEER_LIVE_MS: "1500",
});
await sleep(1500);
try {
  const H = mk(`http://127.0.0.1:${PH}`);
  await H.post("/policy", { autonomy: { alpha: 2 } });
  // The standing pair beats continuously; a THIRD seat flaps in and out of liveness. Old keying:
  // {host,codex} and {host,codex,kimi} are two episodes -> 2 warns. Fixed: one holds throughout.
  let flap = false;
  const beat = setInterval(() => {
    H.post("/register", { session: "host:alpha", project: "alpha" }).catch(() => {});
    H.post("/register", { session: "codex:alpha", project: "alpha" }).catch(() => {});
    if (flap) H.post("/register", { session: "kimi:alpha", project: "alpha" }).catch(() => {});
  }, 150);
  await sleep(900);               // pair alone: the episode opens (warn #1)
  flap = true;  await sleep(900); // trio joins: SAME condition, must stay quiet
  flap = false; await sleep(900); // trio leaves: SAME condition, must stay quiet
  clearInterval(beat);
  const ev = await H.get("/events?type=overseer.&limit=100");
  const warns = (ev.events ?? []).filter(e => e.type === "overseer.warn" && e.kind === "same-project-sessions");
  ok(warns.length === 1, `membership churn holds ONE episode (got ${warns.length})`);

  // A NEWCOMER to a standing episode still needs the intro — it was not present at episode start,
  // so it never learned the others' ids — but it must NOT re-open the episode (no new warn) and
  // existing members must NOT re-hear the intro. kimi joined mid-episode: exactly one 🤝 addressed
  // to kimi, naming the existing parties it now overlaps with.
  const msgEv = await H.get("/events?type=message&limit=200");
  const kimiIntros = (msgEv.events ?? []).filter(e => e.toSession === "kimi:alpha" && /🤝 OVERSEER/.test(e.text || ""));
  ok(kimiIntros.length === 1, `newcomer to a standing episode gets exactly ONE 🤝 (got ${kimiIntros.length})`);
  const firstIntro = kimiIntros[0]?.text || "";
  ok(/host:alpha/.test(firstIntro) && /codex:alpha/.test(firstIntro),
     "the newcomer intro names the existing parties it now overlaps with");
  const memberIntros = (msgEv.events ?? []).filter(e => /🤝 OVERSEER/.test(e.text || "") && e.toSession !== "kimi:alpha");
  ok(memberIntros.length === 2, `each existing member introed once at episode start, never re-heard (got ${memberIntros.length})`);

  // The fix must not swallow genuine recurrence: let it clear past CLEAR_MS, recur -> warn again.
  await sleep(6200);
  await H.post("/register", { session: "host:alpha", project: "alpha" });
  await H.post("/register", { session: "codex:alpha", project: "alpha" });
  await sleep(1200);
  const ev2 = await H.get("/events?type=overseer.&limit=100");
  const warns2 = (ev2.events ?? []).filter(e => e.type === "overseer.warn" && e.kind === "same-project-sessions");
  ok(warns2.length === 2, `recurrence after a genuine clear still re-warns (got ${warns2.length})`);
} catch (e) { fail++; console.log(`  ✗ churn: ${e.message}`); }
finally { hubH.kill(); }

// ── #5760: a DECLARED CREW is the normal state, not a collision ────────────────────────────────
// The seats `trantor up` spawned plus the operator's orchestrator are how every project normally
// looks — a crew-only same-project set must not warn, not DM, and not even reach the context
// feed. Only a session OUTSIDE the declared crew is a collision. The crew declaration is HUB
// state now (#6075): peer rows carry kind — "agent" for seats announced by `trantor up`
// (crew-runner stamps every /register), "orch" for the project's orchestrator pane. NO local
// crew-windows.txt is written here: this hub's HOME is a fixture dir on purpose, the same way
// the production netcup hub has no operator-machine files to read.
const PI = 47939;
const dirI = mkdtempSync(join(tmpdir(), "trantor-overseer-crew-"));
mkdirSync(join(dirI, ".agent-bus"), { recursive: true });
const hubI = spawnHub(PI, {}, dirI);
await sleep(1500);
try {
  const I = mk(`http://127.0.0.1:${PI}`);
  await I.post("/policy", { autonomy: { alpha: 2 } });
  // The declared crew, live and beating: three seats (kind "agent") plus the project's
  // orchestrator (kind "orch") — all of it HUB state, nothing on disk.
  const beatCrew = setInterval(() => {
    I.post("/register", { session: "codex:alpha", project: "alpha", kind: "agent" }).catch(() => {});
    I.post("/register", { session: "kimi:alpha", project: "alpha", kind: "agent" }).catch(() => {});
    I.post("/register", { session: "glm:alpha", project: "alpha", kind: "agent" }).catch(() => {});
    I.post("/register", { session: "MacBook-Pro-M1:alpha", project: "alpha", kind: "orch" }).catch(() => {});
  }, 150);
  await sleep(2500);
  let ev = await I.get("/events?type=overseer.&limit=100");
  ok((ev.events ?? []).filter(e => e.type === "overseer.warn" && e.kind === "same-project-sessions").length === 0,
     "a live declared crew (3 seats + orch, by peer kind) alone never warns");
  let ctx = await I.get("/overseer/context?project=alpha");
  ok(!(ctx.warnings ?? []).some(w => w.kind === "same-project-sessions"),
     "a crew-only set is not a collision: absent from /overseer/context too");
  // A stranger joins — outside the declaration. ONE warn, naming it; the crew is not re-heard.
  const beatAll = setInterval(() => {
    I.post("/register", { session: "stranger:alpha", project: "alpha" }).catch(() => {});
  }, 150);
  await sleep(2500);
  clearInterval(beatCrew); clearInterval(beatAll);
  ev = await I.get("/events?type=overseer.&limit=100");
  const crewWarns = (ev.events ?? []).filter(e => e.type === "overseer.warn" && e.kind === "same-project-sessions");
  ok(crewWarns.length === 1, `an intruder alongside the crew warns exactly ONCE (got ${crewWarns.length})`);
  ok(crewWarns.length === 1 && (crewWarns[0].sessions ?? []).includes("stranger:alpha"),
     "the warn names the intruder's session id");
  ctx = await I.get("/overseer/context?project=alpha");
  const standing = (ctx.warnings ?? []).find(w => w.kind === "same-project-sessions");
  ok(Boolean(standing), "the standing episode is visible in /overseer/context");
  ok(/same-project for/.test(standing?.detail || ""), "the record line reports DURATION, not repetition");
  ok(Number(standing?.since) > 0, "the record line carries since");
  const msgEv = await I.get("/events?type=message&limit=200");
  const intros = (msgEv.events ?? []).filter(e => /🤝 OVERSEER/.test(e.text || ""));
  const bySession = {};
  for (const m of intros) bySession[m.toSession] = (bySession[m.toSession] || 0) + 1;
  ok(bySession["stranger:alpha"] === 1, `the intruder gets exactly one intro (got ${bySession["stranger:alpha"]})`);
  ok((bySession["codex:alpha"] || 0) <= 1 && (bySession["kimi:alpha"] || 0) <= 1,
     `crew members are introed at most once across the episode (got ${JSON.stringify(bySession)})`);
} catch (e) { fail++; console.log(`  ✗ crew: ${e.message}`); }
finally { hubI.kill(); rmSync(dirI, { recursive: true, force: true }); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// trantor overseer e2e tests — autonomy levels, collision detection, narration, file holds.
// Collision detection is mechanical; narration does not decide whether work is held.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestHub } from "../lib/test-hub.mjs";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${name}`); };

const spawnHub = (extraEnv = {}, dir = mkdtempSync(join(tmpdir(), "trantor-overseer-"))) =>
  startTestHub({ dir, env: { RELAY_AUTH: "off", RELAY_OVERSEER_TICK_MS: "1000", ...extraEnv } });
const mk = (base) => ({
  post: (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json()),
  get: (p) => fetch(base + p).then(r => r.json()),
});

console.log("# trantor overseer e2e tests");

// ── /policy defaults + set/get round-trip ─────────────────────────────────────────────────────
const hubA = await spawnHub();
try {
  const A = mk(hubA.base);
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
finally { await hubA.stop(); }

// ── overseer tick: same-project-sessions at level>=2 ───────────────────────────────────────────
const hubB = await spawnHub();
try {
  const B = mk(hubB.base);
  await B.post("/policy", { autonomy: { alpha: 2 } });
  await B.post("/register", { session: "host:alpha", project: "alpha", status: "orchestrating" });
  await B.post("/register", { session: "codex:alpha", project: "alpha", status: "ready" });
  await sleep(2500);
  const ev = await B.get("/events?type=overseer.&limit=10");
  const warns = (ev.events ?? []).filter(e => e.type === "overseer.warn" && e.kind === "same-project-sessions");
  ok(warns.length >= 1, `overseer.warn same-project-sessions emitted (got ${warns.length})`);
} catch (e) { fail++; console.log(`  ✗ tick same-project: ${e.message}`); }
finally { await hubB.stop(); }

// ── file-conflict from /claim ──────────────────────────────────────────────────────────────────
const hubC = await spawnHub();
try {
  const C = mk(hubC.base);
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
finally { await hubC.stop(); }

// ── level 1: events still logged, /overseer/context.warnings populated ──────────────────────────
const hubD = await spawnHub();
try {
  const D = mk(hubD.base);
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
finally { await hubD.stop(); }

// ── level 3 + file-conflict -> enforced hold ─────────────────────────────────────────────────────
const hubE = await spawnHub();
try {
  const E = mk(hubE.base);
  await E.post("/policy", { autonomy: { alpha: 3 } });
  await E.post("/register", { session: "host:alpha", project: "alpha" });
  await E.post("/register", { session: "codex:alpha", project: "alpha" });
  await E.post("/claim", { project: "alpha", file: "src/x.ts", session: "host:alpha" });
  await E.post("/claim", { project: "alpha", file: "src/x.ts", session: "codex:alpha" });
  await sleep(2500);
  const holds = await E.get("/holds?project=alpha");
  const hold = holds.holds?.find(h => h.status === "pending" && h.file === "src/x.ts" && h.session === "codex:alpha" && h.other === "host:alpha");
  ok(Boolean(hold), "level 3 + file-conflict: later writer has a pending hold");
  const holdEv = await E.get("/events?type=hold.");
  ok((holdEv.events ?? []).some(e => e.type === "hold.opened" && e.holdId === hold?.id),
     "hold.opened event logged");
  const edit = { project: "alpha", file: "src/x.ts", session: "codex:alpha" };
  const denied = await E.post("/hold/check", edit);
  ok(denied.hold?.id === hold?.id && denied.hold?.reason === "held: file conflict with host:alpha, waiting on the operator",
     "held writer's edit check is denied with the conflicting session");
  const decision = await E.post("/hold/decide", { project: "alpha", id: hold?.id, status: "go" });
  ok(decision.ok === true && decision.hold?.status === "go", "operator Go releases the held writer");
  const allowed = await E.post("/hold/check", edit);
  ok(allowed.ok === true && allowed.hold === null, "held writer's edit check is allowed after Go");
} catch (e) { fail++; console.log(`  ✗ level 3 gate: ${e.message}`); }
finally { await hubE.stop(); }

// ── POST /overseer/narrate marks event narrated ────────────────────────────────────────────────
const hubF = await spawnHub();
try {
  const F = mk(hubF.base);
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
finally { await hubF.stop(); }

// ── EPISODES, not a metronome (episode regression) ──────────────────────────────────────────
// A standing condition warns once; only a genuine clear and recurrence may warn again.
const hubG = await spawnHub({
  RELAY_OVERSEER_TICK_MS: "300", RELAY_OVERSEER_CLEAR_MS: "2500",
  RELAY_OVERSEER_PEER_LIVE_MS: "2500",  // so the condition can actually go away inside a test —
  // but with margin: the original 800ms window was narrower than an event-loop stall on a loaded
  // machine, so a stretched heartbeat FLAPPED the condition and the hub (correctly, per its own
  // contract) opened a fresh episode. "got 2/3/4 warns" tracked machine load exactly (#4854 family).
});
try {
  const G = mk(hubG.base);
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
finally { await hubG.stop(); }

// ── EPISODE IDENTITY is the condition, not the membership (fixes #5350) ────────────────────────
// Membership changes must preserve the standing episode while introducing newcomers once.
const hubH = await spawnHub({
  RELAY_OVERSEER_TICK_MS: "300", RELAY_OVERSEER_CLEAR_MS: "1500", RELAY_OVERSEER_PEER_LIVE_MS: "1500",
});
try {
  const H = mk(hubH.base);
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
finally { await hubH.stop(); }

// ── #5760: a DECLARED CREW is the normal state, not a collision ────────────────────────────────
// Declared crew members are normal project activity; an undeclared stranger opens an episode.
const dirI = mkdtempSync(join(tmpdir(), "trantor-overseer-crew-"));
mkdirSync(join(dirI, ".agent-bus"), { recursive: true });
const hubI = await spawnHub({}, dirI);
try {
  const I = mk(hubI.base);
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
finally { await hubI.stop(); rmSync(dirI, { recursive: true, force: true }); }

// ── #6170: a hub restart must not forget who is crew ──────────────────────────────────────────
// Persisted peer kinds preserve crew membership across hub restarts.
console.log("\n#6170: peer kinds survive a hub restart");
{
  const dirK = mkdtempSync(join(tmpdir(), "trantor-overseer-kind-"));
  let hubK = await spawnHub({}, dirK);
  try {
    const K = mk(hubK.base);
    await K.post("/register", { session: "claude:kk", project: "kk", status: "active", kind: "agent" });
    await K.post("/register", { session: "mac:kk", project: "kk", status: "orchestrating", kind: "orch" });
    await K.post("/register", { session: "sasha@mac", project: "kk", status: "watching" });
    // the beat that carries no kind — the one that used to demote the orchestrator
    await K.post("/register", { session: "mac:kk", project: "kk" });

    const kindOf = (peers, sid) => (peers.find(p => p.session === sid) || {}).kind || "";
    const before = (await K.get("/peers")).peers;
    ok(kindOf(before, "claude:kk") === "agent" && kindOf(before, "mac:kk") === "orch",
       "kinds are set before the restart (positive control)");

    await sleep(1200);                       // let the persist tick write
    await hubK.stop();
    hubK = await spawnHub({}, dirK);         // SAME data dir: this is a restart, not a new hub

    const after = (await mk(hubK.base).get("/peers")).peers;
    ok(kindOf(after, "claude:kk") === "agent", "#6170: a crew seat is still 'agent' after the restart");
    ok(kindOf(after, "mac:kk") === "orch", "#6170: the orchestrator is still 'orch' after the restart");
    ok(kindOf(after, "sasha@mac") === "", "#6170: a peer that never declared a kind is not given one");
  } catch (e) { fail++; console.log(`  ✗ #6170 restart: ${e.message}`); }
  finally { await hubK.stop(); rmSync(dirK, { recursive: true, force: true }); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

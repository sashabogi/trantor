#!/usr/bin/env node
// #8723 — a TTL-expired peer must keep its durable fields (kind, deliveredUpTo, lastSeen).
// Isolated: random port, tmp dirs, RELAY_AUTH=off, fast ticks.
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { startTestHub } from "../lib/test-hub.mjs";

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); } };

const dir = mkdtempSync(join(tmpdir(), `tpm-${process.pid}-${randomBytes(3).toString("hex")}-`));
mkdirSync(join(dir, ".agent-bus"), { recursive: true });
const env = {
  HOME: dir, AGENT_BUS_DIR: join(dir, ".agent-bus"), RELAY_DATA_DIR: dir,
  RELAY_HOST: "127.0.0.1", RELAY_AUTH: "off",
  RELAY_DUTY_SESSION: "claude:trantor-duty",
  RELAY_DUTY_UNDELIVERED_MS: "500",
  RELAY_OVERSEER_TICK_MS: "200",
  RELAY_ONLINE_MS: "200",
  RELAY_PEER_TTL_MS: "600",
  RELAY_PEER_FORGET_MS: "30000",   // far above every sleep below, so the kept window cannot race the forget bound
};
const hub = await startTestHub({ dir, env });
const B = hub.base;
const j = (r) => r.json();
const post = (p, b) => fetch(B + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(j);
const get = (p) => fetch(B + p).then(j);

try {
  console.log("\n# test-peer-memory — the peer row outlives its own presence (#8723)");

  // Crew seats + orchestrator register WITH their kind, then go quiet past the peer TTL.
  await post("/register", { session: "host:mem", project: "mem", status: "orchestrating", kind: "orch" });
  await post("/register", { session: "glm:mem", project: "mem", status: "active", kind: "agent" });
  await post("/send", { from: "host:mem", to: "glm:mem", text: "contract you will answer", project: "mem" });
  const box = await get(`/inbox?session=${encodeURIComponent("glm:mem")}&since=0`);   // non-peek: advances the ledger
  const deliveredId = (box.messages || []).filter(m => m.to === "glm:mem").pop()?.id ?? 0;
  ok("the message reached the seat before the idle window", deliveredId > 0, JSON.stringify(box).slice(0, 120));

  await sleep(1200);                        // past RELAY_PEER_TTL_MS
  await get("/peers");                      // GET /peers runs prunePeers()

  // The row survives, and with it the delivery watermark duty reads. It is INTERNAL state now:
  // /peer still answers it for diagnostics, but no peer listing (/peers, board) may show it.
  const peer = await get(`/peer?session=${encodeURIComponent("glm:mem")}`).catch(() => null);
  ok("the expired peer row still exists", !!peer && !peer.error, JSON.stringify(peer || {}));
  ok("…and keeps its deliveredUpTo watermark", (peer?.deliveredUpTo || 0) >= deliveredId, JSON.stringify(peer || {}));
  const roster = await get("/peers");
  ok("…but is absent from the /peers roster", !(roster.peers || []).some(p => p.session === "glm:mem"),
    JSON.stringify((roster.peers || []).map(p => p.session)));

  // A kindless heartbeat beat (what hooks/heartbeat.mjs sends) must not demote the kept row.
  await post("/register", { session: "glm:mem", project: "mem" });
  await post("/register", { session: "host:mem", project: "mem" });
  const roster2 = await get("/peers");
  ok("a kindless beat does not demote a kept row", (roster2.peers || []).find(p => p.session === "glm:mem")?.kind === "agent",
    `got ${JSON.stringify((roster2.peers || []).find(p => p.session === "glm:mem")?.kind)}`);

  // The crew-only pair re-live on the project: the overseer must stay silent about its own crew…
  await sleep(1000);                        // > overseer tick + undelivered window
  const duty = await get(`/inbox?session=${encodeURIComponent("claude:trantor-duty")}&since=0&peek=1`);
  const undelivered = (duty.messages || []).filter(m => /UNDELIVERED/.test(m.text) && /glm:mem/.test(m.text));
  ok("consumed mail is not escalated UNDELIVERED after idle", undelivered.length === 0, JSON.stringify(undelivered).slice(0, 200));
  const warns = await get(`/events?project=mem&type=overseer.warn`);
  const crewWarns = (warns.events || []).filter(e => e.kind === "same-project-sessions");
  ok("a live crew-only project draws zero same-project warnings", crewWarns.length === 0, JSON.stringify(crewWarns).slice(0, 200));

  // …positive control: a genuinely kindless stranger on the same project still warns.
  await post("/register", { session: "stranger:mem", project: "mem", status: "watching" });
  await sleep(1000);
  const warns2 = await get(`/events?project=mem&type=overseer.warn`);
  const strangerWarns = (warns2.events || []).filter(e => e.kind === "same-project-sessions" && (e.sessions || []).includes("stranger:mem"));
  ok("an unknown session on the project still warns (positive control)", strangerWarns.length >= 1, JSON.stringify(warns2.events || []).slice(0, 200));

  // --- the forget bound (#8723 bounce) ----------------------------------------------------------
  // KEPT window (the "7h" case): quiet past the TTL but far under the forget window — this hub's
  // RELAY_PEER_FORGET_MS=30000 cannot fire during the test, so what survives here is the bound
  // itself: kind and watermark live on, but the board agents list no longer shows the row.
  await post("/register", { session: "host:frget", project: "mem", status: "orchestrating", kind: "orch" });
  await post("/register", { session: "glm:frget", project: "mem", status: "active", kind: "agent" });
  await post("/send", { from: "host:frget", to: "glm:frget", text: "contract to watermark before idle", project: "mem" });
  const box2 = await get(`/inbox?session=${encodeURIComponent("glm:frget")}&since=0`);
  const frgetId = (box2.messages || []).filter(m => m.to === "glm:frget").pop()?.id ?? 0;
  ok("the forget-case message reached the seat", frgetId > 0, JSON.stringify(box2).slice(0, 120));

  await sleep(1000);                        // quiet > RELAY_PEER_TTL_MS(600): a memory row
  await get("/peers");                      // runs prunePeers()
  const kept = await get(`/peer?session=${encodeURIComponent("glm:frget")}`).catch(() => null);
  ok("a peer quiet past the TTL but inside the forget window still exists", !!kept && !kept.error, JSON.stringify(kept || {}));
  ok("…and keeps its deliveredUpTo watermark", (kept?.deliveredUpTo || 0) >= frgetId, JSON.stringify(kept || {}));
  const roster3 = await get("/peers");
  ok("…but is absent from the /peers roster too", !(roster3.peers || []).some(p => p.session === "glm:frget"), "");
  const board = await get("/projects");
  const boardSessions = ((board.projects || []).find(p => p.project === "mem")?.agents || []).map(a => a.session);
  ok("…but is absent from the board agents list", !boardSessions.includes("glm:frget"), JSON.stringify(boardSessions));

  // A kindless beat re-registers the seat (fresh lastSeen): the kept row's kind must have survived
  // both the quiet window and the beat — /peers lists it again, still the crew "agent" kind.
  await post("/register", { session: "glm:frget", project: "mem" });
  const roster5 = await get("/peers");
  ok("a kindless beat after the quiet window keeps the kind", (roster5.peers || []).find(p => p.session === "glm:frget")?.kind === "agent",
    JSON.stringify((roster5.peers || []).find(p => p.session === "glm:frget") || {}));

  // FORGOTTEN window (the "31-day" case): a second hub with a SHORT override deletes the row once
  // quiet crosses RELAY_PEER_FORGET_MS — impossible under the 30-day default, so the deletion at
  // ~3s of quiet is itself the proof that the env override is read.
  const dir2 = mkdtempSync(join(tmpdir(), `tpm2-${process.pid}-${randomBytes(3).toString("hex")}-`));
  mkdirSync(join(dir2, ".agent-bus"), { recursive: true });
  const hub2 = await startTestHub({ dir: dir2, env: { ...env, HOME: dir2, AGENT_BUS_DIR: join(dir2, ".agent-bus"), RELAY_DATA_DIR: dir2, RELAY_PEER_FORGET_MS: "2500" } });
  const post2 = (p, b) => fetch(hub2.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json());
  const get2 = (p) => fetch(hub2.base + p).then(r => r.json());
  await post2("/register", { session: "glm:frget2", project: "mem", status: "active", kind: "agent" });
  await sleep(3200);                        // quiet > RELAY_PEER_FORGET_MS(2500)
  await get2("/peers");                     // runs prunePeers()
  const gone = await get2(`/peer?session=${encodeURIComponent("glm:frget2")}`).catch(() => null);
  ok("a peer quiet past the forget window is deleted (short override; default is 30 days)", !gone || !!gone.error, JSON.stringify(gone || {}));
  const roster4 = await get2("/peers");
  ok("…and is gone from the roster too", !(roster4.peers || []).some(p => p.session === "glm:frget2"), "");
  await hub2.stop();
  try { rmSync(dir2, { recursive: true, force: true }); } catch {}
} finally {
  await hub.stop();
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

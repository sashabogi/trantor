#!/usr/bin/env node
// #8723 — a TTL-expired peer must keep its durable fields (kind, deliveredUpTo, lastSeen).
// Isolated: random port, tmp dirs, RELAY_AUTH=off, fast ticks.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { drillEnv } from "../drill-env.mjs";

const HERE = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/[^/]+$/, "");
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); } };

const dir = mkdtempSync(join(tmpdir(), `tpm-${process.pid}-${randomBytes(3).toString("hex")}-`));
mkdirSync(join(dir, ".agent-bus"), { recursive: true });
const port = 5000 + Math.floor(Math.random() * 20000);
const env = {
  ...drillEnv(), HOME: dir, AGENT_BUS_DIR: join(dir, ".agent-bus"), RELAY_DATA_DIR: dir,
  RELAY_PORT: String(port), RELAY_HOST: "127.0.0.1", RELAY_AUTH: "off",
  RELAY_DUTY_SESSION: "claude:trantor-duty",
  RELAY_DUTY_UNDELIVERED_MS: "500",
  RELAY_OVERSEER_TICK_MS: "200",
  RELAY_ONLINE_MS: "200",
  RELAY_PEER_TTL_MS: "600",
};
delete env.RELAY_URL;
let hub = spawn(process.execPath, [join(HERE, "hub.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
let er = ""; hub.stderr.on("data", d => { er += d; });
const B = `http://127.0.0.1:${port}`;
const j = (r) => r.json();
const post = (p, b) => fetch(B + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(j);
const get = (p) => fetch(B + p).then(j);

try {
  let up = false;
  for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(B + "/health")).ok; } catch {} if (!up) await sleep(80); }
  if (!up) throw new Error("hub no start: " + er.slice(-300));
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

  // The row survives, and with it the delivery watermark duty reads. /peer does not serialize
  // kind, so the kind assertions read the /peers roster — the same field declaredCrewFor scans.
  const peer = await get(`/peer?session=${encodeURIComponent("glm:mem")}`).catch(() => null);
  ok("the expired peer row still exists", !!peer && !peer.error, JSON.stringify(peer || {}));
  ok("…and keeps its deliveredUpTo watermark", (peer?.deliveredUpTo || 0) >= deliveredId, JSON.stringify(peer || {}));
  const roster = await get("/peers");
  const rowOf = s => (roster.peers || []).find(p => p.session === s) || {};
  ok("…and keeps the kind that declaredCrewFor reads", rowOf("glm:mem").kind === "agent", `got ${JSON.stringify(rowOf("glm:mem").kind)}`);

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
} finally {
  try { hub.kill(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// #5686 — the janitor must not die silently (hub half). Own hub instance: a tiny dark threshold
// here would poison test-duty.mjs's sections, where duty is expected to be treated as alive.
// Asserts: dark duty shows on /health · escalations re-route to the SENDER while dark · the
// dark/back transitions land as EVENTS (episodes, one per transition).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { randomBytes } from "node:crypto";

const HERE = fileURLToPath(new URL(".", import.meta.url)).replace(/\/[^/]+$/, "");
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); } };

const dir = mkdtempSync(join(tmpdir(), `tdd-${process.pid}-${randomBytes(3).toString("hex")}-`));
mkdirSync(join(dir, ".agent-bus"), { recursive: true });
const port = 5000 + Math.floor(Math.random() * 20000);
const env = {
  ...process.env, HOME: dir, AGENT_BUS_DIR: join(dir, ".agent-bus"), RELAY_DATA_DIR: dir,
  RELAY_PORT: String(port), RELAY_HOST: "127.0.0.1", RELAY_AUTH: "off",
  RELAY_DUTY_SESSION: "claude:trantor-duty",
  RELAY_DUTY_UNDELIVERED_MS: "600",
  RELAY_DUTY_DARK_MS: "700",
  RELAY_OVERSEER_TICK_MS: "300",
  RELAY_ONLINE_MS: "60000",
};
delete env.RELAY_URL;
const hub = spawn(process.execPath, [join(HERE, "hub.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
let er = ""; hub.stderr.on("data", d => { er += d; });
const B = `http://127.0.0.1:${port}`;
const j = (r) => r.json();
const post = (p, b) => fetch(B + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(j);
const get = (p) => fetch(B + p).then(j);

try {
  let up = false;
  for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(B + "/health")).ok; } catch {} if (!up) await sleep(80); }
  if (!up) throw new Error("hub no start: " + er.slice(-300));
  console.log("\n# test-duty-dark — a dead janitor is visible and routed around");

  // Duty never polls: after a couple of ticks the hub must call it dark, on /health.
  await sleep(1200);
  let h = await get("/health");
  ok("duty is configured on /health", h.duty?.configured === true, JSON.stringify(h.duty));
  ok("a duty seat with no heartbeat reads DARK (online:false)", h.duty?.online === false, JSON.stringify(h.duty));

  // An undelivered DM while dark: the escalation goes to the SENDER, never the corpse.
  await post("/send", { from: "arch:projA", to: "ghost:projA", text: "please do the thing", project: "projA" });
  await sleep(1800);
  const senderBox = await get(`/inbox?session=${encodeURIComponent("arch:projA")}&since=0&peek=1`);
  const routed = (senderBox.messages || []).filter(m => m.from === "hub:duty" && /UNDELIVERED/.test(m.text));
  ok("while dark, the escalation reaches the SENDER (the party owed the reply)", routed.length >= 1,
    JSON.stringify((senderBox.messages || []).map(m => `${m.from}->${m.to}`)));
  const dutyBox = await get(`/inbox?session=${encodeURIComponent("claude:trantor-duty")}&since=0&peek=1`);
  const wasted = (dutyBox.messages || []).filter(m => m.from === "hub:duty" && /UNDELIVERED/.test(m.text));
  ok("…and is NOT queued on the dead duty seat", wasted.length === 0, `${wasted.length} queued on the corpse`);

  // The transition landed as an EVENT (episode, not a nag).
  const ev1 = await get("/events?type=duty-dark&limit=10");
  ok("the dark transition is one duty-dark event", (ev1.events || []).length === 1, JSON.stringify(ev1.events?.length));

  // Duty comes back (one poll = heartbeat): /health flips, and duty-back lands once.
  await get(`/inbox?session=${encodeURIComponent("claude:trantor-duty")}&since=0&peek=1`);
  await sleep(400);   // one tick (300ms) inside the 700ms freshness window — checking later just re-darkens
  h = await get("/health");
  ok("a heartbeat flips duty back ONLINE on /health", h.duty?.online === true, JSON.stringify(h.duty));
  const ev2 = await get("/events?type=duty-back&limit=10");
  ok("the recovery is one duty-back event", (ev2.events || []).length === 1, JSON.stringify(ev2.events?.length));
} catch (e) {
  ok("suite ran", false, String(e?.stack || e).slice(0, 300));
} finally {
  hub.kill(); await sleep(200);
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

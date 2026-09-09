#!/usr/bin/env node
// THE WAKE DRILL — a duty seat that is BEATING BUT NOT CONSUMING must be routed around.
//
// This is the 2026-09-09 incident as an executable test, and it is the one thing on that day's
// list that would have CAUGHT the failure rather than reported it afterwards.
//
// What happened: the duty seat parked on a quota failure and stopped working, but its long-poll —
// which IS its heartbeat — kept running. So the hub saw a fresh heartbeat every few seconds and
// called it online for 21.9 hours while it held 48 escalations it could not touch. The #5686
// self-healing path (route escalations to the SENDER rather than queue them on a corpse) never
// armed, because it only asks "is duty beating". The orchestrator slept through a night of
// finished crew work as a direct result.
//
// test-duty-dark.mjs already covers the CRASHED case: no heartbeat at all. This covers the one
// that actually bit, and that is strictly harder to see: a seat that looks perfectly alive.
//
// The drill: duty POLLS throughout (so it is always beating) but never consumes its escalations.
// The hub must notice anyway, flip it dark, and re-route to the sender.
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

const dir = mkdtempSync(join(tmpdir(), `tds-${process.pid}-${randomBytes(3).toString("hex")}-`));
mkdirSync(join(dir, ".agent-bus"), { recursive: true });
const port = 5000 + Math.floor(Math.random() * 20000);
const DUTY = "claude:trantor-duty";
const env = {
  ...drillEnv(), HOME: dir, AGENT_BUS_DIR: join(dir, ".agent-bus"), RELAY_DATA_DIR: dir,
  RELAY_PORT: String(port), RELAY_HOST: "127.0.0.1", RELAY_AUTH: "off",
  RELAY_DUTY_SESSION: DUTY,
  RELAY_DUTY_UNDELIVERED_MS: "600",
  // Generous, so duty stays comfortably BEATING for the whole run: the point is that a healthy
  // heartbeat must not be enough to keep it online.
  RELAY_DUTY_DARK_MS: "60000",
  RELAY_OVERSEER_TICK_MS: "300",
  RELAY_ONLINE_MS: "60000",
  // The stuck floors, shrunk to drill scale. Production is 10 escalations / 30 minutes.
  RELAY_DUTY_STUCK_MAX: "3",
  RELAY_DUTY_STUCK_MS: "1500",
};
delete env.RELAY_URL;
const hub = spawn(process.execPath, [join(HERE, "hub.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
let er = ""; hub.stderr.on("data", d => { er += d; });
const B = `http://127.0.0.1:${port}`;
const j = (r) => r.json();
const post = (p, b) => fetch(B + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(j);
const get = (p) => fetch(B + p).then(j);
/** Duty's heartbeat WITHOUT consuming: peek=1 reads the mail and never advances deliveredUpTo. */
const dutyBeatOnly = () => get(`/inbox?session=${encodeURIComponent(DUTY)}&since=0&peek=1`);

try {
  let up = false;
  for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(B + "/health")).ok; } catch {} if (!up) await sleep(80); }
  if (!up) throw new Error("hub no start: " + er.slice(-300));
  console.log("\n# test-duty-stuck-drill — a seat that beats but does not work is still dark");

  // Duty is alive and polling from the start. Nothing here is a corpse.
  await dutyBeatOnly();
  await sleep(500);
  let h = await get("/health");
  ok("duty starts ONLINE — beating and consuming, nothing to do yet", h.duty?.online === true, JSON.stringify(h.duty));

  // Four undelivered DMs, all to a session that never polls. The hub escalates each to duty.
  for (let i = 0; i < 4; i++) {
    await post("/send", { from: "arch:projA", to: "ghost:projA", text: `work item ${i}`, project: "projA" });
  }
  // Duty keeps heartbeating the whole time and consumes NOTHING — the parked-seat signature.
  for (let i = 0; i < 10; i++) { await dutyBeatOnly(); await sleep(300); }

  h = await get("/health");
  ok("duty is still BEATING — the heartbeat never stopped", h.duty?.beating === true, JSON.stringify(h.duty));
  ok("but it is NOT CONSUMING — the backlog is large and stale", h.duty?.consuming === false, JSON.stringify(h.duty));
  ok("SO THE HUB CALLS IT DARK — this is the assertion that was missing on 09-09",
    h.duty?.online === false, JSON.stringify(h.duty));
  ok("and it says how many escalations are stuck", Number(h.duty?.stuck) >= 3, JSON.stringify(h.duty));

  // The payoff: with duty dark, #5686 re-routes to the party owed the reply.
  await post("/send", { from: "arch:projA", to: "ghost:projA", text: "the one that matters", project: "projA" });
  await sleep(1500);
  const senderBox = await get(`/inbox?session=${encodeURIComponent("arch:projA")}&since=0&peek=1`);
  const routed = (senderBox.messages || []).filter(m => m.from === "hub:duty" && /UNDELIVERED/.test(m.text));
  ok("the escalation reaches the SENDER instead of the stuck seat — the loop self-heals",
    routed.length >= 1, `${routed.length} routed to the sender`);

  // The dark event must name WHICH kind of dark: "up and stuck" needs a restart, "crashed" does not
  // look the same to an operator reading the log.
  const ev = await get("/events?type=duty-dark&limit=10");
  const texts = (ev.events || []).map(e => String(e.text || e.detail?.text || ""));
  ok("one duty-dark event, not a nag", (ev.events || []).length === 1, String((ev.events || []).length));
  ok("the event says HEARTBEATING BUT NOT CONSUMING, not 'no heartbeat'",
    texts.some(t => /NOT CONSUMING/.test(t)), JSON.stringify(texts).slice(0, 220));

  // Recovery: duty starts consuming again (a real read, no peek) and the hub lets it back.
  await get(`/inbox?session=${encodeURIComponent(DUTY)}&since=0`);
  await sleep(700);
  h = await get("/health");
  ok("consuming again flips duty back ONLINE", h.duty?.online === true, JSON.stringify(h.duty));
  const back = await get("/events?type=duty-back&limit=10");
  ok("the recovery is one duty-back event", (back.events || []).length === 1, String((back.events || []).length));
} catch (e) {
  ok("suite ran", false, String(e?.stack || e).slice(0, 300));
} finally {
  hub.kill(); await sleep(200);
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

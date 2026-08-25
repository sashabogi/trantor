#!/usr/bin/env node
// trantor — duty-agent hub feed acceptance (bin/duty.mjs is the seat; this tests the HUB half).
// Isolated: random port, tmp dirs, RELAY_AUTH=off, fast ticks.
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

const dir = mkdtempSync(join(tmpdir(), `td-${process.pid}-${randomBytes(3).toString("hex")}-`));
mkdirSync(join(dir, ".agent-bus"), { recursive: true });
const port = 5000 + Math.floor(Math.random() * 20000);
const env = {
  ...process.env, HOME: dir, AGENT_BUS_DIR: join(dir, ".agent-bus"), RELAY_DATA_DIR: dir,
  RELAY_PORT: String(port), RELAY_HOST: "127.0.0.1", RELAY_AUTH: "off",
  RELAY_DUTY_SESSION: "claude:trantor-duty",
  RELAY_DUTY_UNDELIVERED_MS: "600",       // 0.6s: "undelivered" fast
  RELAY_OVERSEER_TICK_MS: "300",          // duty tick shares this cadence
  RELAY_ONLINE_MS: "60000",
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
  console.log("\n# test-duty — hub escalation feed for the duty agent");

  // 0. mail addressed to the hub's own pseudo-identity must NEVER escalate. Nothing polls hub:*,
  // so it can never be delivered; escalating it makes the duty seat ack into the same hole, and
  // that ack escalates in turn. The seat reported it as "a fresh identical echo every stop-hook
  // cycle" and it ran for hours.
  await post("/send", { from: "claude:trantor-duty", to: "hub:duty", text: "Ack #9059. standing closure applies", project: "projA" });
  await sleep(1800);
  {
    const box = await get(`/inbox?session=${encodeURIComponent("claude:trantor-duty")}&since=0&peek=1`);
    const echo = (box.messages || []).filter(m => m.from === "hub:duty" && /-> hub:duty/.test(m.text));
    ok("a message addressed to hub:* is never escalated back", echo.length === 0,
      `${echo.length} echo(es): ${echo.map(m => m.text.slice(0, 70)).join(" | ")}`);
  }

  // 0b. A HUMAN endpoint read in the desktop app must be able to record delivery. The app lists
  // with peek=1 on purpose, so sasha@mac's deliveredUpTo sat at 0 forever while 17 messages piled
  // up — every one of them escalated to the duty seat as undelivered, which then messaged the
  // human about it, which was also undelivered. Six escalations a minute about mail already read.
  await post("/send", { from: "arch:projA", to: "sasha@mac", text: "a question for the human", project: "projA" });
  const humanBox = await get(`/inbox?session=${encodeURIComponent("sasha@mac")}&since=0&peek=1`);
  const humanMsg = (humanBox.messages || []).filter(m => m.to === "sasha@mac").pop();
  ok("the human's message is there to be read", !!humanMsg, JSON.stringify(humanBox).slice(0, 120));
  const ackRes = await post("/delivered", { session: "sasha@mac", upTo: humanMsg?.id ?? 0 });
  await sleep(1800);
  {
    const box = await get(`/inbox?session=${encodeURIComponent("claude:trantor-duty")}&since=0&peek=1`);
    const nagged = (box.messages || []).filter(m => m.from === "hub:duty" && new RegExp(`#${humanMsg?.id}\\b`).test(m.text));
    ok("a message the human has acknowledged is not escalated", nagged.length === 0,
      `${nagged.length}: ${nagged.map(m => m.text.slice(0, 80)).join(" | ")}`);
    // Straight from the endpoint that recorded it — /peers does not serialize deliveredUpTo.
    ok("…and the hub reports the new delivery watermark", (ackRes?.deliveredUpTo || 0) >= (humanMsg?.id ?? 1),
      JSON.stringify(ackRes || {}));
    const again = await post("/delivered", { session: "sasha@mac", upTo: 1 });
    ok("…monotonically — a lower ack never rewinds it", (again?.deliveredUpTo || 0) >= (humanMsg?.id ?? 1),
      JSON.stringify(again || {}));
  }

  // 1. a DM to a session nobody delivers -> duty gets ONE escalation citing it
  await post("/send", { from: "arch:projA", to: "ghost:projA", text: "please do the thing", project: "projA" });
  await sleep(1800);   // > undelivered window + a couple of ticks
  let inbox = await get(`/inbox?session=${encodeURIComponent("claude:trantor-duty")}&since=0&peek=1`);
  let esc = (inbox.messages || []).filter(m => m.from === "hub:duty" && /UNDELIVERED/.test(m.text));
  ok("undelivered DM escalates to the duty session", esc.length >= 1, `got ${esc.length}`);
  ok("escalation cites sender, recipient, and content", esc.length > 0 && /arch:projA/.test(esc[0].text) && /ghost:projA/.test(esc[0].text) && /please do the thing/.test(esc[0].text));
  ok("escalation is hub-authored, not impersonated", esc.every(m => m.from === "hub:duty"));
  await sleep(1000);
  inbox = await get(`/inbox?session=${encodeURIComponent("claude:trantor-duty")}&since=0&peek=1`);
  const esc2 = (inbox.messages || []).filter(m => m.from === "hub:duty" && /UNDELIVERED/.test(m.text));
  ok("a standing outage escalates ONCE (dedup per message)", esc2.length === esc.length, `${esc.length} -> ${esc2.length}`);

  // 2. a DELIVERED message never escalates
  await post("/send", { from: "arch:projA", to: "alive:projA", text: "you will hear this", project: "projA" });
  await get(`/inbox?session=${encodeURIComponent("alive:projA")}&since=0`);   // non-peek: advances the ledger
  await sleep(1500);
  inbox = await get(`/inbox?session=${encodeURIComponent("claude:trantor-duty")}&since=0&peek=1`);
  ok("delivered messages do not escalate", !(inbox.messages || []).some(m => /alive:projA/.test(m.text) && /UNDELIVERED/.test(m.text)));

  // 3. broadcasts never escalate
  await post("/send", { from: "arch:projA", to: "all", text: "broadcast noise", project: "projA" });
  await sleep(1500);
  inbox = await get(`/inbox?session=${encodeURIComponent("claude:trantor-duty")}&since=0&peek=1`);
  ok("broadcasts do not escalate", !(inbox.messages || []).some(m => /broadcast noise/.test(m.text) && /UNDELIVERED/.test(m.text)));

  // 4. messages TO the duty session never re-escalate (no feedback loop)
  await post("/send", { from: "arch:projA", to: "claude:trantor-duty", text: "direct ask for duty", project: "projA" });
  await sleep(1500);
  inbox = await get(`/inbox?session=${encodeURIComponent("claude:trantor-duty")}&since=0&peek=1`);
  ok("no self-escalation loop for duty's own inbox", !(inbox.messages || []).some(m => /direct ask for duty/.test(m.text) && /UNDELIVERED/.test(m.text)));

  // 5. an overseer warning is forwarded to duty
  await post("/policy", { autonomy: { projB: 2 } });
  await post("/register", { session: "a:projB", project: "projB", status: "working" });
  await post("/register", { session: "b:projB", project: "projB", status: "working" });
  await sleep(1500);
  inbox = await get(`/inbox?session=${encodeURIComponent("claude:trantor-duty")}&since=0&peek=1`);
  const ow = (inbox.messages || []).filter(m => m.from === "hub:duty" && /OVERSEER same-project-sessions/.test(m.text) && /projB/.test(m.text));
  ok("overseer warning is forwarded to the duty session", ow.length >= 1, `got ${ow.length}`);

  // 6. the seat can name ITSELF at runtime — `trantor duty up` talks to a hub it cannot set env on
  //    (regression: DUTY_SESSION was a boot-time const, so a remote hub could never be told).
  let st = await get("/overseer/status");
  ok("status reports the boot-time duty session", st.dutySession === "claude:trantor-duty", `got ${JSON.stringify(st.dutySession)}`);
  const setRes = await post("/overseer/duty", { session: "claude:relief" });
  ok("POST /overseer/duty accepts a new seat", setRes.ok === true && setRes.dutySession === "claude:relief", JSON.stringify(setRes));
  st = await get("/overseer/status");
  ok("status reflects the runtime duty session", st.dutySession === "claude:relief");
  await post("/send", { from: "arch:projC", to: "ghost:projC", text: "after the handover", project: "projC" });
  await sleep(1800);
  const relief = await get(`/inbox?session=${encodeURIComponent("claude:relief")}&since=0&peek=1`);
  ok("escalations follow the new seat", (relief.messages || []).some(m => m.from === "hub:duty" && /after the handover/.test(m.text)));
  const oldSeat = await get(`/inbox?session=${encodeURIComponent("claude:trantor-duty")}&since=0&peek=1`);
  ok("the replaced seat stops receiving escalations", !(oldSeat.messages || []).some(m => /after the handover/.test(m.text)));
  const badRes = await post("/overseer/duty", {});
  ok("a missing session field is rejected", !!badRes.error);
  const clearRes = await post("/overseer/duty", { session: "" });
  ok("an empty session clears the duty seat", clearRes.ok === true && clearRes.dutySession === "");
  st = await get("/overseer/status");
  ok("a cleared duty seat reads as empty, not stale", st.dutySession === "");

  // 7. it survives a hub restart — otherwise the feed dies silently whenever the hub bounces
  //    and the seat, still running, looks perfectly healthy.
  await post("/overseer/duty", { session: "claude:relief" });
  await sleep(1400);                                   // persist runs on a 1s timer
  hub.kill(); await sleep(400);
  const envNoDuty = { ...env }; delete envNoDuty.RELAY_DUTY_SESSION;
  hub = spawn(process.execPath, [join(HERE, "hub.mjs")], { env: envNoDuty, stdio: ["ignore", "pipe", "pipe"] });
  hub.stderr.on("data", d => { er += d; });
  let back = false;
  for (let i = 0; i < 90 && !back; i++) { try { back = (await fetch(B + "/health")).ok; } catch {} if (!back) await sleep(80); }
  ok("hub restarts", back, er.slice(-200));
  st = await get("/overseer/status");
  ok("the duty seat survives a hub restart with no env var", st.dutySession === "claude:relief", `got ${JSON.stringify(st.dutySession)}`);
} finally {
  try { hub.kill(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

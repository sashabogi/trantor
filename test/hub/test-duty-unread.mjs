#!/usr/bin/env node
// #7131 — a nudge must verify the thing that matters: will /inbox hand this message to that session?
//
// The duty seat nudged an idle orchestrator for "1 unread (#17816)". There was nothing to read:
// #17816 was the duty seat's own patrol report, posted to the project LANE ("trantor"), which no
// session is ever handed. It was undelivered in the ledger and not deliverable to anyone, and the
// gap between those two is exactly the set of messages a session can never see. The wake cost a turn.
//
// Own hub instance. Asserts, in order:
//   · lane mail (to: "<project>") is never escalated as UNDELIVERED — the hub half;
//   · a real DM to a session still IS escalated — the feature the nudge exists for;
//   · GET /unread answers from the read path's own predicate: a deliverable unread DM is listed,
//     a self-send is not, a lane post is not, peeking does not consume, a real read does;
//   · `ids=` narrows the answer to the escalation being verified.
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

const dir = mkdtempSync(join(tmpdir(), `tdu-${process.pid}-${randomBytes(3).toString("hex")}-`));
mkdirSync(join(dir, ".agent-bus"), { recursive: true });
const port = 5000 + Math.floor(Math.random() * 20000);
const DUTY = "claude:trantor-duty";
const ORCH = "MacBook-Pro-M1:trantor";
const env = {
  ...drillEnv(), HOME: dir, AGENT_BUS_DIR: join(dir, ".agent-bus"), RELAY_DATA_DIR: dir,
  RELAY_PORT: String(port), RELAY_HOST: "127.0.0.1", RELAY_AUTH: "off",
  RELAY_DUTY_SESSION: DUTY,
  RELAY_DUTY_UNDELIVERED_MS: "600",
  RELAY_DUTY_DARK_MS: "60000",
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
const inbox = (session, extra = "&peek=1") => get(`/inbox?session=${encodeURIComponent(session)}&since=0${extra}`);
const unread = (session, ids = "") => get(`/unread?session=${encodeURIComponent(session)}${ids ? `&ids=${ids}` : ""}`);
const escalationsFor = (msgs, id) => (msgs || []).filter(m => m.from === "hub:duty" && new RegExp(`UNDELIVERED[^#]*#${id}\\b`).test(m.text));

try {
  let up = false;
  for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(B + "/health")).ok; } catch {} if (!up) await sleep(80); }
  if (!up) throw new Error("hub no start: " + er.slice(-300));
  console.log("\n# test-duty-unread — a nudge asks what /inbox will answer, not what the ledger says");

  // Duty heartbeats (one poll) so escalations route to it, not to senders; the orchestrator registers.
  await inbox(DUTY);
  await inbox(ORCH);

  // The incident: the duty seat's own patrol report, posted to the project lane.
  const lane = await post("/send", { from: DUTY, to: "trantor", text: "Duty: patrol clean, 8 backlog unreads nudged via relay_send.", project: "trantor-duty" });
  // A real DM to a session nobody has seen yet — the case escalation exists for.
  const ghost = await post("/send", { from: "arch:projA", to: "ghost:projA", text: "please do the thing", project: "projA" });
  await sleep(1800);   // past RELAY_DUTY_UNDELIVERED_MS and several ticks
  const dutyBox = await inbox(DUTY);
  ok("lane mail (to: \"trantor\") is NOT escalated as UNDELIVERED", escalationsFor(dutyBox.messages, lane.id).length === 0,
    JSON.stringify((dutyBox.messages || []).map(m => m.text.slice(0, 60))));
  ok("a DM to a session still IS escalated — the feature stays", escalationsFor(dutyBox.messages, ghost.id).length === 1,
    JSON.stringify((dutyBox.messages || []).map(m => m.text.slice(0, 60))));

  // /unread for the orchestrator: an unread DM is listed; the lane post is not; a self-send is not.
  const dm = await post("/send", { from: "codex:trantor", to: ORCH, text: "#6452 done, testing green", project: "trantor" });
  const self = await post("/send", { from: ORCH, to: ORCH, text: "note to self", project: "trantor" });
  let u = await unread(ORCH);
  ok("/unread lists the deliverable unread DM", u.unread?.includes(dm.id), JSON.stringify(u));
  ok("/unread knows the session and its ledger", u.known === true && Number.isFinite(u.deliveredUpTo), JSON.stringify(u));
  ok("/unread omits the lane post the ledger would call undelivered", !u.unread?.includes(lane.id), JSON.stringify(u));
  ok("/unread omits a self-send the ledger would call undelivered", !u.unread?.includes(self.id), JSON.stringify(u));
  // Parity with the read path itself: whatever /inbox would hand over is exactly the unread set.
  const peek = await inbox(ORCH);
  ok("/unread equals what /inbox (peek) would hand over", JSON.stringify(u.unread) === JSON.stringify((peek.messages || []).map(m => m.id)),
    `unread=${JSON.stringify(u.unread)} inbox=${JSON.stringify((peek.messages || []).map(m => m.id))}`);

  // ids= narrows to the escalation being verified — the runner's one question per nudge.
  const narrowed = await unread(ORCH, `${dm.id}`);
  ok("ids= narrows to the asked id when it is unread", JSON.stringify(narrowed.unread) === JSON.stringify([dm.id]), JSON.stringify(narrowed));
  const narrowedLane = await unread(ORCH, `${lane.id}`);
  ok("ids= answers an empty set for mail the session can never read", narrowedLane.unread?.length === 0 && narrowedLane.count === 0, JSON.stringify(narrowedLane));

  // Peeking (the app, the stop hook's first look) never consumes; a real read does.
  u = await unread(ORCH);
  ok("a peek did not consume it — still unread", u.unread?.includes(dm.id), JSON.stringify(u));
  await inbox(ORCH, "");
  u = await unread(ORCH);
  ok("a real /inbox read consumes it — /unread is now empty", u.unread?.length === 0 && u.count === 0, JSON.stringify(u));
  ok("the ledger advanced past the DM", u.deliveredUpTo >= dm.id, JSON.stringify(u));

  // A session the hub has never seen: answered from a zero ledger, flagged unknown, never a 404.
  const never = await unread("ghost:projA");
  ok("a never-seen session is answered (known:false), not refused", never.known === false && never.unread?.includes(ghost.id), JSON.stringify(never));

  const bad = await fetch(`${B}/unread`);
  ok("session is required", bad.status === 400);
} catch (e) {
  ok("suite ran", false, String(e?.stack || e).slice(0, 400));
} finally {
  hub.kill(); await sleep(200);
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

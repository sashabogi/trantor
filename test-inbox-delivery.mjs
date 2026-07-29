#!/usr/bin/env node
// trantor — tests for INTERSESSION MESSAGE DELIVERY: the Stop hook that keeps a session from going idle
// on an unread peer message, and the hub read receipts that track how far an inbox was handed over.
//
// Runs the hub on an ISOLATED port with an isolated state file — never touches the live board.
// Also guards the invariant that a peer is never addressable as a terminal (see hub.mjs touch()).
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.WAKE_TEST_PORT || 4491);
const URL_BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); } };

const dir = mkdtempSync(join(tmpdir(), "trantor-wake-"));
let hub;

async function post(path, body) {
  const r = await fetch(URL_BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
async function get(path) { const r = await fetch(URL_BASE + path); return { status: r.status, body: await r.json().catch(() => ({})) }; }

async function startHub() {
  hub = spawn(process.execPath, [join(HERE, "hub.mjs")], {
    env: { ...process.env, RELAY_PORT: String(PORT), RELAY_HOST: "127.0.0.1", RELAY_STATE: join(dir, "bus.json"), AGENT_BUS_DIR: dir },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try { await fetch(URL_BASE + "/peers"); return; } catch { await sleep(100); }
  }
  throw new Error("hub did not start");
}

// ---------------------------------------------------------------- hub state
async function testReceipts() {
  // A peer must never carry a routable terminal address. /send is unauthenticated and `from` is
  // self-asserted, so storing one would let any local process aim keystrokes at a session that may be
  // running with permissions bypassed. This guard exists so the idea cannot quietly come back.
  console.log("\nHub: a peer is NOT addressable as a terminal:");
  await post("/register", { session: "h:alpha", project: "alpha", pane: { tty: "/dev/ttys009", windowId: "260", host: "h" } });
  let r = await get("/peer?session=h:alpha");
  ok("a pane address offered by a client is REFUSED, not stored", !r.body.pane && !r.body.tty && !r.body.windowId,
     JSON.stringify(r.body));
  const peers = await get("/peers");
  const alpha = (peers.body.peers || []).find(p => p.session === "h:alpha");
  ok("...and never appears in /peers either", alpha && !("windowId" in alpha) && !("tty" in alpha));

  r = await get("/peer?session=h:nobody");
  ok("/peer 404s for an unknown peer", r.status === 404);

  console.log("\nHub: read receipts (how far a session's inbox was actually handed over):");
  await post("/register", { session: "h:beta", project: "beta" });
  const { id } = await post("/send", { from: "h:beta", to: "h:alpha", text: "ping one" });
  r = await get("/peer?session=h:alpha");
  ok("ledger starts behind an undelivered message", (r.body.deliveredUpTo || 0) < id, `deliveredUpTo=${r.body.deliveredUpTo} id=${id}`);

  await get(`/inbox?session=${encodeURIComponent("h:alpha")}&since=0`);
  r = await get("/peer?session=h:alpha");
  ok("/inbox advances the ledger past the message", (r.body.deliveredUpTo || 0) >= id);

  const before = r.body.deliveredUpTo;
  await get(`/inbox?session=${encodeURIComponent("h:alpha")}&since=0`);
  r = await get("/peer?session=h:alpha");
  ok("ledger is monotonic (a re-read never rewinds it)", r.body.deliveredUpTo === before);

  console.log("\nHub: /peer does not fake presence:");
  const t0 = (await get("/peer?session=h:beta")).body.lastSeen;
  await sleep(30);
  await get("/peer?session=h:beta");
  const t1 = (await get("/peer?session=h:beta")).body.lastSeen;
  ok("asking about a peer does not touch it", t0 === t1);
}

// ---------------------------------------------------------------- T2: the Stop hook
// A message landing as a turn ENDS. We still have the model's attention, so blocking the stop and handing
// the message over is delivery through the session's OWN harness — no reaching into a process we don't own.
async function testStopHook() {
  console.log("\nStop hook: won't go idle with a peer waiting:");
  const S = "h:stoptest";
  // The hook shares inbox-deliver.mjs's cursor at $HOME/.agent-bus; HOME points at the sandbox here.
  mkdirSync(join(dir, ".agent-bus"), { recursive: true });
  const cursorFile = join(dir, ".agent-bus", `inbox-cursor-${S.replace(/[^A-Za-z0-9_.-]/g, "_")}.id`);
  const runStop = (stopHookActive = false) => {
    const out = execFileSync(process.execPath, [join(HERE, "hooks", "stop-inbox.mjs")], {
      input: JSON.stringify({ stop_hook_active: stopHookActive, cwd: HERE }),
      env: { ...process.env, RELAY_URL: URL_BASE, RELAY_SESSION: S, RELAY_PROJECT: "stoptest", HOME: dir },
      timeout: 15000, encoding: "utf8",
    });
    try { return JSON.parse(out || "{}"); } catch { return { _unparseable: out }; }
  };

  await post("/register", { session: S, project: "stoptest" });
  writeFileSync(cursorFile, "0");

  ok("empty inbox -> allows the stop", !runStop().decision);

  const { id: dm } = await post("/send", { from: "h:beta", to: S, text: "I finished the migration, your turn" });
  const blocked = runStop();
  ok("an unread DIRECT message BLOCKS the stop", blocked.decision === "block", JSON.stringify(blocked).slice(0, 120));
  ok("the message text is handed to the model", /I finished the migration/.test(blocked.reason || ""));
  ok("the sender is named", /h:beta/.test(blocked.reason || ""));
  ok("it tells the model it won't be blocked twice", /not block you a second time/.test(blocked.reason || ""));

  ok("after surfacing, the same message does not block again", !runStop().decision);

  console.log("\nStop hook: the guards:");
  const { id: dm2 } = await post("/send", { from: "h:beta", to: S, text: "second one" });
  ok("stop_hook_active ALWAYS allows (never loops)", !runStop(true).decision);
  ok("...and a peek did not falsely claim delivery", (await get(`/peer?session=${encodeURIComponent(S)}`)).body.deliveredUpTo < dm2,
     `deliveredUpTo=${(await get(`/peer?session=${encodeURIComponent(S)}`)).body.deliveredUpTo} dm2=${dm2}`);
  ok("so it still blocks on the next real stop", runStop().decision === "block");

  await post("/send", { from: "h:beta", to: "all", text: "broadcast — everyone please note" });
  ok("a BROADCAST never blocks the stop", !runStop().decision);

  await post("/send", { from: "h:beta", to: S, text: "disabled path" });
  const off = execFileSync(process.execPath, [join(HERE, "hooks", "stop-inbox.mjs")], {
    input: JSON.stringify({ stop_hook_active: false, cwd: HERE }),
    env: { ...process.env, RELAY_URL: URL_BASE, RELAY_SESSION: S, RELAY_PROJECT: "stoptest", HOME: dir, RELAY_STOP_INBOX: "0" },
    timeout: 15000, encoding: "utf8",
  });
  ok("RELAY_STOP_INBOX=0 disables it", !JSON.parse(off || "{}").decision);

  const noCursor = "h:nocursor";
  await post("/register", { session: noCursor, project: "nocursor" });
  await post("/send", { from: "h:beta", to: noCursor, text: "old backlog message" });
  const fresh = execFileSync(process.execPath, [join(HERE, "hooks", "stop-inbox.mjs")], {
    input: JSON.stringify({ stop_hook_active: false, cwd: HERE }),
    env: { ...process.env, RELAY_URL: URL_BASE, RELAY_SESSION: noCursor, RELAY_PROJECT: "nocursor", HOME: dir },
    timeout: 15000, encoding: "utf8",
  });
  ok("a session with no cursor yet is not blocked by the backlog", !JSON.parse(fresh || "{}").decision);

  const down = execFileSync(process.execPath, [join(HERE, "hooks", "stop-inbox.mjs")], {
    input: JSON.stringify({ stop_hook_active: false, cwd: HERE }),
    env: { ...process.env, RELAY_URL: "http://127.0.0.1:4599", RELAY_SESSION: S, RELAY_PROJECT: "stoptest", HOME: dir },
    timeout: 15000, encoding: "utf8",
  });
  ok("a DOWN hub allows the stop (never traps a session)", !JSON.parse(down || "{}").decision);

  console.log("\nStop hook keeps the read receipt honest:");
  const { id: dm3 } = await post("/send", { from: "h:beta", to: S, text: "handled at stop time" });
  ok("blocks on it", runStop().decision === "block");
  const led = (await get(`/peer?session=${encodeURIComponent(S)}`)).body.deliveredUpTo;
  ok("surfacing it DOES claim delivery (receipt advances)", led >= dm3, `deliveredUpTo=${led} dm3=${dm3}`);
}

// ---------------------------------------------------------------- run
try {
  await startHub();

  await testReceipts();

  await testStopHook();


} catch (e) {
  fail++; console.log(`  ✗ harness error: ${e && e.message}`);
} finally {
  try { hub?.kill(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log(`\ntest-inbox-delivery: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

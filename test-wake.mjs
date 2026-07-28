#!/usr/bin/env node
// trantor — tests for waking an IDLE peer (lib/wake.mjs + bin/wake-peer.mjs + the hub's pane/ledger state).
//
// Runs the hub on an ISOLATED port with an isolated state file — never touches the live board.
// The AppleScript end-to-end case is opt-in (RELAY_WAKE_E2E=1) because it opens a real Terminal window;
// everything else runs headless and is safe in CI.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { escapeForAppleScript, formatWakeText, MAX_INJECT } from "./lib/wake.mjs";

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

// ---------------------------------------------------------------- pure helpers
function testEscaping() {
  console.log("\nAppleScript escaping (what a peer can put in a message):");
  ok("escapes double quotes", escapeForAppleScript('say "hi"') === 'say \\"hi\\"');
  ok("escapes backslashes before quotes", escapeForAppleScript('C:\\path "x"') === 'C:\\\\path \\"x\\"');
  ok("flattens newlines to one line (never submits in pieces)", !/[\r\n]/.test(escapeForAppleScript("a\nb\r\nc")));
  ok("newline becomes a separator, not a join", escapeForAppleScript("a\nb") === "a b");
  ok("strips control chars the tty would interpret", escapeForAppleScript("a\x07\x1bb") === "ab");
  ok("keeps emoji intact", escapeForAppleScript("📨 ok").includes("📨"));
  ok("null/undefined never throw", escapeForAppleScript(null) === "" && escapeForAppleScript(undefined) === "");

  console.log("\nWake text formatting:");
  const t = formatWakeText("MacBook-Pro-M1:crebral-health", "deploy is green", 42);
  ok("marks the traffic as bus, not human", t.startsWith("[trantor]") && t.includes("DIRECT from"));
  ok("names the sender", t.includes("MacBook-Pro-M1:crebral-health"));
  ok("cites the message id", t.includes("#42"));
  ok("carries the body", t.includes("deploy is green"));
  const big = formatWakeText("a:b", "x".repeat(MAX_INJECT + 500), 1);
  ok("truncates a huge message instead of pasting it whole", big.length < MAX_INJECT + 300 && big.includes("truncated"));
}

// ---------------------------------------------------------------- hub state
async function testHubPaneAndLedger() {
  console.log("\nHub: pane address registration:");
  await post("/register", { session: "h:alpha", project: "alpha", pane: { tty: "/dev/ttys009", windowId: "260", host: "h" } });
  let r = await get("/peer?session=h:alpha");
  ok("/peer returns the registered pane", r.body.pane?.windowId === "260" && r.body.pane?.tty === "/dev/ttys009");
  ok("/peer reports the host that owns the pane", r.body.pane?.host === "h");

  const peers = await get("/peers");
  const alpha = (peers.body.peers || []).find(p => p.session === "h:alpha");
  ok("pane address is NOT leaked into /peers", alpha && !("windowId" in alpha) && !("tty" in alpha));

  r = await get("/peer?session=h:nobody");
  ok("/peer 404s for an unknown peer", r.status === 404);

  await post("/register", { session: "h:alpha", project: "alpha" });
  r = await get("/peer?session=h:alpha");
  ok("a heartbeat without a pane does not erase the known one", r.body.pane?.windowId === "260");

  console.log("\nHub: delivery ledger:");
  await post("/register", { session: "h:beta", project: "beta", pane: { tty: "/dev/ttys010", windowId: "261", host: "h" } });
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

// ---------------------------------------------------------------- waker decisions
async function testWakerStandsDown() {
  console.log("\nWaker: stands down when it should (no terminal touched):");
  // The waker logs to $HOME/.agent-bus/wake.log; we point HOME at the sandbox, so the dir must exist.
  mkdirSync(join(dir, ".agent-bus"), { recursive: true });
  const logFile = join(dir, ".agent-bus", "wake.log");
  const runWaker = async (to, msgId) => {
    rmSync(logFile, { force: true });
    execFileSync(process.execPath, [join(HERE, "bin", "wake-peer.mjs"), to, String(msgId), URL_BASE],
      { env: { ...process.env, RELAY_WAKE_DELAY_MS: "50", RELAY_WAKE_DEBUG: "1", HOME: dir, RELAY_WAKE_HOST: "h" }, timeout: 20000 });
    return existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  };

  // already-delivered: the common case — recipient was merely busy and self-served in the delay window
  const { id: m1 } = await post("/send", { from: "h:beta", to: "h:alpha", text: "already seen" });
  await get(`/inbox?session=${encodeURIComponent("h:alpha")}&since=0`);
  ok("no wake when the ledger already covers the message", /already delivered/.test(await runWaker("h:alpha", m1)));

  // no pane address recorded
  await post("/register", { session: "h:nopane", project: "nopane" });
  const { id: m2 } = await post("/send", { from: "h:beta", to: "h:nopane", text: "hello" });
  ok("no wake when the peer has no pane address", /no pane address/.test(await runWaker("h:nopane", m2)));

  // peer belongs to another machine
  await post("/register", { session: "other:gamma", project: "gamma", pane: { tty: "/dev/ttys011", windowId: "999", host: "otherbox" } });
  const { id: m3 } = await post("/send", { from: "h:beta", to: "other:gamma", text: "hello" });
  ok("never types into another host's terminal", /not ours to wake/.test(await runWaker("other:gamma", m3)));

  // unknown peer entirely
  ok("unknown peer is a no-op", /peer lookup failed/.test(await runWaker("h:ghost", 999999)));

  // disabled by env
  const { id: m4 } = await post("/send", { from: "h:beta", to: "h:alpha", text: "off" });
  rmSync(logFile, { force: true });
  execFileSync(process.execPath, [join(HERE, "bin", "wake-peer.mjs"), "h:alpha", String(m4), URL_BASE],
    { env: { ...process.env, RELAY_WAKE: "0", RELAY_WAKE_DELAY_MS: "50", RELAY_WAKE_DEBUG: "1", HOME: dir }, timeout: 20000 });
  ok("RELAY_WAKE=0 disables it entirely", /disabled by RELAY_WAKE=0/.test(existsSync(logFile) ? readFileSync(logFile, "utf8") : ""));

  // a stale pane address must not type into an unrelated window
  await post("/register", { session: "h:stale", project: "stale", pane: { tty: "/dev/ttys999", windowId: "424242", host: "h" } });
  const { id: m5 } = await post("/send", { from: "h:beta", to: "h:stale", text: "stale pane" });
  const out = await runWaker("h:stale", m5);
  ok("a stale/invalid pane is rejected, not typed into", /pane-invalid/.test(out) || /no pane address/.test(out), out.trim());
}

// ---------------------------------------------------------------- injected prompt must not become a focus card
// A woken message arrives through the SAME door as a human prompt (UserPromptSubmit). Without a guard,
// hooks/prompt-focus.mjs would card a peer's message as this session's focus — putting another agent's
// words on the board as our objective, and burying whatever the human actually asked for.
async function testInjectedPromptIsNotFocus() {
  console.log("\nA woken message must not be carded as this session's focus:");
  const runPromptFocus = (prompt) => {
    execFileSync(process.execPath, [join(HERE, "hooks", "prompt-focus.mjs")], {
      input: JSON.stringify({ prompt, cwd: HERE }),
      env: { ...process.env, RELAY_URL: URL_BASE, RELAY_SESSION: "h:focustest", RELAY_PROJECT: "focustest", HOME: dir },
      timeout: 15000, encoding: "utf8",
    });
  };
  const cards = async () => (await get("/tasks?project=focustest")).body.tasks?.filter(t => t.source === "session") || [];

  runPromptFocus("Refactor the wake ladder so idle sessions get messages");
  ok("a real human prompt still creates a focus card", (await cards()).length === 1, `got ${(await cards()).length}`);

  runPromptFocus(formatWakeText("h:beta", "the deploy finished, your turn", 7));
  const after = await cards();
  ok("an injected bus message creates NO new focus card", after.length === 1, `got ${after.length}`);
  ok("and does not re-title the existing focus card", !/DIRECT from/.test(after[0]?.title || ""), after[0]?.title);
}

// ---------------------------------------------------------------- real end-to-end
async function testE2E() {
  if (process.env.RELAY_WAKE_E2E !== "1") {
    console.log("\nEnd-to-end AppleScript wake: SKIPPED (set RELAY_WAKE_E2E=1 — opens a real Terminal window)");
    return;
  }
  if (process.platform !== "darwin") { console.log("\nEnd-to-end wake: SKIPPED (not macOS)"); return; }
  console.log("\nEnd-to-end: waking a REAL idle terminal:");
  const sinkLog = join(dir, "sink.log");
  const sink = join(dir, "sink.mjs");
  writeFileSync(sink, `
import fs from "node:fs"; import { execSync } from "node:child_process";
const log=${JSON.stringify(sinkLog)};
fs.writeFileSync(log, "tty="+execSync("tty",{encoding:"utf8",stdio:["inherit","pipe","pipe"]}).trim()+"\\npid="+process.pid+"\\n");
process.stdin.setEncoding("utf8"); let b="";
process.stdin.on("data",d=>{b+=d;let i;while((i=b.indexOf("\\n"))>=0){fs.appendFileSync(log,"LINE: "+b.slice(0,i)+"\\n");b=b.slice(i+1);}});
setTimeout(()=>process.exit(0), 60000);
`);
  execFileSync("osascript", ["-e", `tell application "Terminal" to do script "node ${sink}"`]);
  await sleep(2500);
  const tty = (readFileSync(sinkLog, "utf8").match(/tty=(\S+)/) || [])[1];
  ok("sink terminal reported its tty", !!tty, String(tty));
  if (!tty) return;

  const { terminalWindowForTty } = await import("./hooks/lib/handoff.mjs");
  const windowId = terminalWindowForTty(tty);
  ok("resolved the sink's Terminal window id", !!windowId, String(windowId));
  if (!windowId) return;

  const hostFromLib = (await import("./lib/project.mjs")).hostId();
  await post("/register", { session: `${hostFromLib}:e2e`, project: "e2e", pane: { tty, windowId, host: hostFromLib } });
  const { id } = await post("/send", { from: "h:beta", to: `${hostFromLib}:e2e`, text: 'build is green — "ship it"' });

  execFileSync(process.execPath, [join(HERE, "bin", "wake-peer.mjs"), `${hostFromLib}:e2e`, String(id), URL_BASE],
    { env: { ...process.env, RELAY_WAKE_DELAY_MS: "300", RELAY_WAKE_DEBUG: "1", HOME: dir }, timeout: 30000 });
  await sleep(1500);

  const log = readFileSync(sinkLog, "utf8");
  ok("the idle session RECEIVED the message on its stdin", /LINE: .*build is green/.test(log), log.split("\n").slice(-3).join(" | "));
  ok("it arrived marked as bus traffic, not as the human", /LINE: \[trantor\].*DIRECT from/.test(log));
  ok("quotes survived the AppleScript round-trip", /"ship it"/.test(log));
  ok("it landed as ONE submission, not several", (log.match(/LINE: /g) || []).length === 1, log);

  // Cleanup order matters: kill the sink FIRST, then close the window. Closing a window whose tab still
  // has a live process makes Terminal put up a "terminate running processes?" modal — which blocks every
  // subsequent AppleScript call and leaves a stray window on the user's desktop. (Observed: the first run
  // of this test leaked exactly one window that way.)
  try {
    const pid = (readFileSync(sinkLog, "utf8").match(/^pid=(\d+)/m) || [])[1];
    if (pid) process.kill(Number(pid), "SIGKILL");
  } catch {}
  await sleep(400);
  try { execFileSync("osascript", ["-e", `tell application "Terminal" to close (every window whose id is ${windowId})`]); } catch {}
}

// ---------------------------------------------------------------- run
try {
  await startHub();
  testEscaping();
  await testHubPaneAndLedger();
  await testWakerStandsDown();
  await testInjectedPromptIsNotFocus();
  await testE2E();
} catch (e) {
  fail++; console.log(`  ✗ harness error: ${e && e.message}`);
} finally {
  try { hub?.kill(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log(`\ntest-wake: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

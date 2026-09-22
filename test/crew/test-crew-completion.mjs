#!/usr/bin/env node
// trantor crew-completion drill — an orchestrator must learn, MECHANICALLY, when a seat it
// dispatched finishes or fails: a silent park and a clean finish must not look identical, so both
// outcomes become a DIRECT machine-readable receipt to whoever assigned the work.
// Hermetic: a mock hub + a fake CLI that never touches the bus itself, driving the REAL runner.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { drillEnv } from "../drill-env.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// #8446: wait on a condition with a deadline instead of betting on a wall-clock budget — a loaded
// box makes the wait longer, never wrong. Returns the check's truthy value, null on deadline.
const waitFor = async (check, timeoutMs = 15000) => {
  const t0 = Date.now();
  for (;;) {
    try { const v = await check(); if (v) return v; } catch {}
    if (Date.now() - t0 >= timeoutMs) return null;
    await sleep(50);
  }
};
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

console.log("# trantor crew-completion drill");

const ORCH = "MacBook-Pro-M1:crebral-health";   // the session that assigns the work
let servedFrom = ORCH;                          // who the waking message claims to be from
// Cites a card because it IS a contract: since #6134 a direct message with no card ref and no
// imperative batches into the seat's next turn instead of buying it a CLI session.
let servedText = "contract: #4411 — take the cardiology formulary file and land the first 40 rules.";
const sends = [];
let served = 0;
const hub = http.createServer((req, res) => {
  let buf = ""; req.on("data", c => (buf += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x"), P = u.pathname;
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "POST" && P === "/send") { try { sends.push(JSON.parse(buf)); } catch {} return reply({ ok: true }); }
    if (P === "/inbox") return reply({ messages: [], cursor: 0 });
    if (P === "/lessons") return reply({ lessons: [] });
    // #6228: the runner drops a wake from an unlinked project's sender, so the mock hub declares
    // the link the drill's fixture implies. Without it the fence refused the wake (#6446, same
    // class #6301 fixed in test-failure.mjs) and every receipt assertion failed on the drop note
    // instead of the completion notice.
    if (P === "/policy") return reply({ links: [{ projects: ["crebral-health", "tt-complete"] }] });
    if (P === "/poll") {
      if (served++ === 0) return reply({ messages: [{ id: 11, from: servedFrom, to: u.searchParams.get("session"),
        text: servedText, ts: Date.now() }], cursor: 1 });
      return setTimeout(() => reply({ messages: [], cursor: 1 }), 250);
    }
    return reply({ ok: true });
  });
});
await new Promise(r => hub.listen(0, "127.0.0.1", r));
const HUB = `http://127.0.0.1:${hub.address().port}`;

// The fake CLI is the whole point: it does the work and ends its turn WITHOUT reporting on the
// bus, exactly like a cheap seat that ignored that line of the RULES prompt.
// #8446: no wall-clock budget — `until(ctx)` names the drill's own terminal signal (the receipt
// landing in sends, or the turnstate file proving the wake turn ENDED), with a 30s deadline.
async function drill({ exitCode = 0, until } = {}) {
  sends.length = 0; served = 0;
  const work = mkdtempSync(join(tmpdir(), "tt-complete-"));
  const HOME = join(work, "home"); mkdirSync(join(HOME, ".agent-bus"), { recursive: true });
  const fakebin = join(work, "bin"); mkdirSync(fakebin, { recursive: true });
  const LOGF = join(work, "turns.log");
  const PROJ = "tt-complete";
  const ctx = {
    logFile: LOGF,
    // #7749: the runner's per-seat turnstate file — phase "idle" is written only when a turn ENDS.
    phase: () => { try { return JSON.parse(read(join(HOME, ".agent-bus", `turnstate-codex-${PROJ}.json`))).phase; } catch { return null; } },
  };
  writeFileSync(join(fakebin, "codex"), `#!/bin/sh
P="$HOME/.agent-bus/turn-codex-${PROJ}.txt"
{ echo "===TURN==="; cat "$P"; } >> "${LOGF}"
# #5481: a real CLI always prints something, so the fixture must too or its success reads as
# empty-output. #7759: short output on an untouched worktree also reads as a hollow EMPTY turn
# now, so the success answer clears the substantive floor — this drill tests the ack, not validity.
echo "the contract is done: the work landed in the worktree, the gate ran green, and the card moved with a note, so this turn consumed its wake."
if grep -q "NEW BUS MESSAGE" "$P"; then exit ${exitCode}; fi
exit 0
`);
  chmodSync(join(fakebin, "codex"), 0o755);
  const runner = spawn("node", ["bin/crew-runner.mjs", "codex", work], {
    cwd: process.cwd(), stdio: "ignore",
    env: { ...drillEnv(), HOME, PATH: `${fakebin}:${process.env.PATH}`,
      RELAY_URL: HUB, RELAY_AGENT: "codex", RELAY_PROJECT: PROJ,
      CREW_KICKOFF: "say hi and end your turn", TRANTOR_RETRY_MS: "1200" },
  });
  await waitFor(() => until(ctx), 30000);
  runner.kill("SIGKILL"); await sleep(150);
  const turns = read(LOGF).split("===TURN===").filter(t => t.trim());
  return { turns, wakeTurns: turns.filter(t => t.includes("NEW BUS MESSAGE")), sends: [...sends] };
}

console.log("\nA seat that finishes its contract reports back, without being asked:");
{
  const previousText = servedText;
  servedText = `contract: #6079 ${"x".repeat(170)} · asked: "an older nested receipt"`;
  const r = await drill({ exitCode: 0, until: () => sends.some(s => s.to === ORCH) });
  servedText = previousText;
  ok("the seat actually ran the contract", r.wakeTurns.length === 1, `${r.wakeTurns.length} wake turn(s)`);
  const done = r.sends.filter(s => s.to === ORCH);
  ok("the ORCHESTRATOR gets a message when the work finishes",
    done.length >= 1, `sends: ${JSON.stringify(r.sends.map(s => ({ to: s.to, text: (s.text || "").slice(0, 60) })))}`);
  ok("…addressed DIRECTLY to it, not broadcast to \"all\" (a broadcast does not wake anyone)",
    done.length >= 1 && done.every(s => s.to !== "all"));
  ok("…and it says the work completed", done.some(s => /\bdone\b|finished|completed/i.test(s.text || "")),
    done.map(s => s.text).join(" | ").slice(0, 160));
  ok("…carrying the outcome, so the orchestrator need not guess",
    done.some(s => /exit 0|✅/.test(s.text || "")), done.map(s => s.text).join(" | ").slice(0, 160));
  ok("…tagged as a machine-readable receipt", done.length >= 1 && done.every(s => s.kind === "receipt"));
  const asked = /asked: "([^"]*)"/.exec(done[0]?.text || "")?.[1] || "";
  ok("…quotes at most one 120-character asked level", asked.length === 120 && !asked.includes("older nested"), asked);
  console.log(`     ↳ what the orchestrator receives: ${JSON.stringify(done[0]?.text || "")}`);
}

console.log("\nA seat whose turn FAILS tells the assigner directly, not just the room:");
{
  const r = await drill({ exitCode: 1, until: () => sends.some(s => s.to === ORCH) });
  const toOrch = r.sends.filter(s => s.to === ORCH);
  ok("the orchestrator is told its contract failed",
    toOrch.length >= 1, `sends: ${JSON.stringify(r.sends.map(s => ({ to: s.to, text: (s.text || "").slice(0, 50) })))}`);
  ok("…and the notice names the failure so it can act (swap the seat, retry, reassign)",
    toOrch.some(s => /fail|error|down|exit [1-9]/i.test(s.text || "")),
    toOrch.map(s => s.text).join(" | ").slice(0, 160));
  console.log(`     ↳ what the orchestrator receives: ${JSON.stringify(toOrch[0]?.text || "")}`);
}

console.log("\nAn outcome is never acked back to a hub pseudo-id (that loops):");
{
  // The duty agent caught this minutes after 0.17.85 shipped: an OVERSEER wake comes from
  // "hub:duty", which never reads its inbox. Acking it goes undelivered, escalates back to duty,
  // and wakes the seat again, so every overseer-woken turn loops forever.
  const prevServe = servedFrom;
  servedFrom = "hub:duty";
  const r = await drill({ exitCode: 0,
    until: (c) => c.phase() === "idle" && read(c.logFile).includes("NEW BUS MESSAGE") });
  servedFrom = prevServe;
  await sleep(250);   // settle: a mis-addressed ack is sent as the turn ends — give it its chance
  ok("the seat still ran the overseer's wake", r.wakeTurns.length === 1, `${r.wakeTurns.length} wake turn(s)`);
  ok("but nothing is addressed back to hub:duty",
    !r.sends.some(s => s.to === "hub:duty"),
    JSON.stringify(r.sends.map(s => ({ to: s.to, text: (s.text || "").slice(0, 40) }))));
}

console.log("\nTwo runners consume receipts and status chatter without starting an echo turn:");
{
  const messages = [];
  let seq = 0;
  // #8446: each runner's latest `since` cursor, recorded where the hub hears it. A runner only
  // presents an advanced cursor after CONSUMING everything up to that id and deciding whether it
  // wakes (deliverWake is awaited before the loop polls again), so the cursor is the runner's own
  // receipt of consumption — the signal every wait below keys on instead of a fixed sleep.
  const seen = {};
  const echoHub = http.createServer((req, res) => {
    let buf = ""; req.on("data", c => (buf += c));
    req.on("end", () => {
      const u = new URL(req.url, "http://x"), P = u.pathname;
      const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.method === "POST" && P === "/send") {
        let body = {}; try { body = JSON.parse(buf); } catch {}
        messages.push({ ...body, id: ++seq, ts: Date.now() });
        return reply({ ok: true, id: seq });
      }
      if (P === "/lessons") return reply({ lessons: [] });
      if (P === "/inbox" || P === "/poll") {
        const since = Number(u.searchParams.get("since") || 0);
        const session = u.searchParams.get("session");
        if (P === "/poll" && session) seen[session] = Math.max(seen[session] || 0, since);
        const found = messages.filter(m => m.id > since && m.from !== session && (m.to === session || m.to === "all"));
        const cursor = found.length ? found.at(-1).id : since;
        return setTimeout(() => reply({ messages: found, cursor }), P === "/poll" && !found.length ? 80 : 0);
      }
      return reply({ ok: true });
    });
  });
  await new Promise(r => echoHub.listen(0, "127.0.0.1", r));
  const echoUrl = `http://127.0.0.1:${echoHub.address().port}`;
  const project = "tt-echo";
  const startRunner = (session) => {
    const work = mkdtempSync(join(tmpdir(), `tt-echo-${session.replaceAll(":", "-")}-`));
    const home = join(work, "home"); mkdirSync(join(home, ".agent-bus"), { recursive: true });
    const fakebin = join(work, "bin"); mkdirSync(fakebin, { recursive: true });
    const logFile = join(work, "turns.log");
    writeFileSync(join(fakebin, "codex"), `#!/bin/sh
P="$HOME/.agent-bus/turn-codex-${project}.txt"
{ echo "===TURN==="; cat "$P"; } >> "${logFile}"
# #7759: the success answer clears the substantive floor, or the wake reads as a hollow EMPTY
# turn and is re-delivered — this drill counts wake turns, not turn validity.
echo "the contract is done: the work landed in the worktree, the gate ran green, and the card moved with a note, so this turn consumed its wake."
exit 0
`);
    chmodSync(join(fakebin, "codex"), 0o755);
    const runner = spawn("node", ["bin/crew-runner.mjs", "codex", work], {
      cwd: process.cwd(), stdio: "ignore",
      env: { ...drillEnv(), HOME: home, PATH: `${fakebin}:${process.env.PATH}`,
        RELAY_URL: echoUrl, RELAY_AGENT: "codex", RELAY_PROJECT: project,
        RUNNER_SESSION: session, CREW_KICKOFF: "say hi and end your turn" },
    });
    return { runner, logFile };
  };
  const sessA = `runner-a:${project}`, sessB = `runner-b:${project}`;
  const a = startRunner(sessA);
  const b = startRunner(sessB);
  const wakeCount = (file) => read(file).split("===TURN===").filter(t => t.includes("NEW BUS MESSAGE")).length;
  // The hub never delivers a session its own sends, so each runner's watermark is the last
  // message deliverable TO it — not the global last id.
  const watermark = (s) => messages.reduce((top, m) =>
    m.from !== s && (m.to === s || m.to === "all") ? Math.max(top, m.id) : top, 0);
  // Both runners parked in the poll loop (past boot + kickoff) before anything is pushed.
  await waitFor(() => seen[sessA] !== undefined && seen[sessB] !== undefined);
  messages.push(
    { id: ++seq, ts: Date.now(), from: sessA, to: sessB, kind: "receipt", re: 4,
      text: `✅ done on runner-a:${project} (exit 0, 1s) · asked: "old contract"` },
    { id: ++seq, ts: Date.now(), from: sessB, to: sessA,
      text: `✅ done on runner-b:${project} (exit 0, 1s) · asked: "older untyped contract"` },
    { id: ++seq, ts: Date.now(), from: sessA, to: "all", kind: "status",
      text: "runner-a reporting — ready for a contract" },
    // #7766: an ack is context only when its sender says so — an unflagged direct message earns a
    // turn whatever it says, so the well-behaved ack carries wake:false.
    { id: ++seq, ts: Date.now(), from: sessA, to: sessB, wake: false,
      text: "thanks, acknowledged" },
  );
  // Both runners have POLLED PAST every message meant for them => consumed and decided, no wake.
  await waitFor(() => seen[sessA] >= watermark(sessA) && seen[sessB] >= watermark(sessB));
  await sleep(250);   // settle: a spawned turn's log line lands just after its cursor advances
  ok("exchanged typed and legacy receipts produce zero turns", wakeCount(a.logFile) === 0 && wakeCount(b.logFile) === 0,
    `runner-a=${wakeCount(a.logFile)}, runner-b=${wakeCount(b.logFile)}, cursors a=${seen[sessA]}/${watermark(sessA)} b=${seen[sessB]}/${watermark(sessB)}`);
  messages.push({ id: ++seq, ts: Date.now(), from: sessA, to: sessB,
    kind: "contract", text: "contract: implement card #6079" });
  // The wake's own evidence is the ===TURN=== marker in b's log — wait for it, 15s deadline.
  const woken = await waitFor(() => wakeCount(b.logFile) === 1);
  ok("a real card contract still wakes exactly one runner", !!woken && wakeCount(a.logFile) === 0,
    `runner-a=${wakeCount(a.logFile)}, runner-b=${wakeCount(b.logFile)}${woken ? "" : " (15s deadline hit)"}`);
  // The receipt b's runner posts for that turn must not wake a: wait until it EXISTS and a has
  // polled past its id — the same consumption signal as the zero-turn case above.
  const receipt = await waitFor(() => messages.find(m => m.from === sessB && m.to === sessA && m.kind === "receipt"));
  if (receipt) await waitFor(() => seen[sessA] >= receipt.id);
  ok("the resulting receipt is typed and does not wake the sender",
    !!receipt && wakeCount(a.logFile) === 0,
    receipt ? `runner-a=${wakeCount(a.logFile)}` : "no receipt from runner-b within 15s");
  a.runner.kill("SIGKILL"); b.runner.kill("SIGKILL"); await sleep(150);
  echoHub.close();
}

console.log("\nAnd the orchestrator actually SEES it, without polling for it:");
{
  // Sending is not arriving. The seat's message only helps if it lands in the orchestrator's
  // context, which is the PostToolUse hook's job. This runs the REAL inbox-deliver.mjs against a
  // hub holding the completion notice and asserts the text reaches additionalContext.
  const { spawn: sp } = await import("node:child_process");
  const w = mkdtempSync(join(tmpdir(), "tt-e2e-"));
  const BUS = join(w, "bus"); mkdirSync(BUS, { recursive: true });
  const repo = join(w, "crebral-health"); mkdirSync(repo, { recursive: true });
  const { spawnSync } = await import("node:child_process");
  spawnSync("git", ["init", "-q"], { cwd: repo });

  const DONE = "✅ done on codex:crebral-health (exit 0, 42s) · asked: \"land the first 40 rules\"";
  const ihub = http.createServer((req, res) => {
    let b = ""; req.on("data", c => (b += c));
    req.on("end", () => {
      const u = new URL(req.url, "http://x");
      res.writeHead(200, { "content-type": "application/json" });
      if (u.pathname === "/inbox") return res.end(JSON.stringify({
        messages: [{ id: 99, from: "codex:crebral-health", to: u.searchParams.get("session"), text: DONE, ts: Date.now() }],
        cursor: 99 }));
      res.end(JSON.stringify({ ok: true, peers: [], messages: [], cursor: 0 }));
    });
  });
  await new Promise(r => ihub.listen(0, "127.0.0.1", r));
  const IHUB = `http://127.0.0.1:${ihub.address().port}`;
  writeFileSync(join(BUS, "config.json"), JSON.stringify({ url: IHUB, hubs: { "crebral-health": IHUB } }));

  const out = await new Promise((resolve) => {
    const kid = sp(process.execPath, ["hooks/inbox-deliver.mjs"], {
      cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"],
      env: { ...drillEnv(), AGENT_BUS_DIR: BUS, CLAUDE_PROJECT_DIR: repo,
             RELAY_SESSION: "", RELAY_PROJECT: "", RELAY_URL: "" },
    });
    let so = ""; kid.stdout.on("data", d => (so += d));
    kid.on("close", () => resolve(so));
    kid.stdin.end(JSON.stringify({ session_id: "e2e-1", cwd: repo }));
    setTimeout(() => { try { kid.kill("SIGKILL"); } catch {} }, 15000).unref?.();
  });
  let ctx = ""; try { ctx = JSON.parse(out || "{}")?.hookSpecificOutput?.additionalContext || ""; } catch {}
  ok("the completion notice reaches the orchestrator's context", ctx.includes("done on codex:crebral-health"), out.slice(0, 160));
  ok("…marked as a DIRECT message, so it is not read as room chatter", /DIRECT/.test(ctx), ctx.slice(0, 200));
  ok("…and it arrives unprompted (the model never called relay_inbox)", /did not poll|arrived while you were working/i.test(ctx), ctx.slice(0, 200));
  if (ctx) console.log(`     ↳ injected: ${JSON.stringify(ctx.split(String.fromCharCode(10))[1] || ctx.slice(0, 120))}`);
  ihub.close();
}

hub.close();
console.log(`\n${fail === 0 ? "✅" : "❌"} crew-completion: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

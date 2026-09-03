#!/usr/bin/env node
// trantor wake-message redelivery drill — proves a crashed turn no longer EATS the message that
// woke it. The hub hands each message out exactly once (the poll cursor advances on read, nothing
// ever re-fires), so before this the escalation that woke a seat during an API outage was gone
// forever with no trace. Delivery is now the runner's job: a message is consumed only by a turn
// that exits 0, it survives a runner restart on disk, and it retries on its own backoff.
// Hermetic: a mock hub (never touches the real ~/.agent-bus/bus.json) + a fake CLI that fails on
// command, driving the REAL bin/crew-runner.mjs.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { drillEnv } from "./drill-env.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

console.log("# trantor wake-message redelivery drill");

// ---- mock hub: hand out ONE direct message, then stay silent forever ------------------
const sends = [];
let served = 0, serveMsg = true;
// The fixture cites a card and gives an instruction ON PURPOSE: since #6134 a direct message
// with neither batches into the next turn's context instead of waking the seat, which is
// exactly right for an ack and exactly wrong for the escalation this drill is about.
const MSG = { id: 7, from: "sasha@mac", to: "", text: "ESCALATION #4242: prod is down, fix it now", ts: Date.now() };
const hub = http.createServer((req, res) => {
  let buf = ""; req.on("data", c => (buf += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x"), P = u.pathname;
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "POST" && P === "/send") { try { sends.push(JSON.parse(buf)); } catch {} return reply({ ok: true }); }
    if (P === "/inbox") return reply({ messages: [], cursor: 0 });
    if (P === "/lessons") return reply({ lessons: [] });
    if (P === "/poll") {
      // exactly once — the hub's real contract. Anything the seat loses after this, it loses.
      if (served++ === 0 && serveMsg) return reply({ messages: [{ ...MSG, to: u.searchParams.get("session") }], cursor: 1 });
      return setTimeout(() => reply({ messages: [], cursor: 1 }), 250);
    }
    return reply({ ok: true });
  });
});
await new Promise(r => hub.listen(0, "127.0.0.1", r));
const HUB = `http://127.0.0.1:${hub.address().port}`;

// ---- harness: the REAL runner + a fake `codex` that fails the first N message turns ----
async function drill({ failTurns = 0, seedPending = null, noMsg = false, waitMs = 9000, noBackoffOverride = false }) {
  sends.length = 0; served = 0; serveMsg = !noMsg;
  const work = mkdtempSync(join(tmpdir(), "tt-redeliver-"));
  const HOME = join(work, "home");
  const BUS = join(HOME, ".agent-bus");
  mkdirSync(BUS, { recursive: true });
  const fakebin = join(work, "bin"); mkdirSync(fakebin, { recursive: true });
  const LOGF = join(work, "turns.log"), CNTF = join(work, "count");
  const PROJ = "tt-redeliver";
  writeFileSync(join(fakebin, "codex"), `#!/bin/sh
P="$HOME/.agent-bus/turn-codex-${PROJ}.txt"
{ echo "===TURN==="; cat "$P"; } >> "${LOGF}"
if grep -q "NEW BUS MESSAGE" "$P"; then
  n=$(cat "${CNTF}" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${CNTF}"
  if [ "$n" -le ${failTurns} ]; then echo "API Error: 529 overloaded" >&2; exit 1; fi
fi
# #5481: a turn with NO output and exit 0 is now the Inception/Mercury failure shape — a real
# CLI always prints something, so the fixture must too or its success reads as empty-output.
echo "codex-drill: turn done"
exit 0
`);
  chmodSync(join(fakebin, "codex"), 0o755);
  const PENDF = join(BUS, `pending-codex-${PROJ}.json`);
  if (seedPending) writeFileSync(PENDF, JSON.stringify(seedPending));

  // TRANTOR_RETRY_MS shortens the backoff ladder so a drill exercises a real retry in seconds;
  // the noBackoffOverride case runs the production ladder instead.
  const runnerEnv = { ...drillEnv(), HOME, PATH: `${fakebin}:${process.env.PATH}`,
    RELAY_URL: HUB, RELAY_AGENT: "codex", RELAY_PROJECT: PROJ,
    CREW_KICKOFF: "say hi and end your turn" };
  if (!noBackoffOverride) runnerEnv.TRANTOR_RETRY_MS = "1200";
  const runner = spawn("node", ["bin/crew-runner.mjs", "codex", work], {
    cwd: process.cwd(), stdio: "ignore",
    env: runnerEnv,
  });
  // sample the pending file WHILE the batch is undelivered — it must exist between attempts
  let sawPendingOnDisk = false;
  const probe = setInterval(() => { if (existsSync(PENDF)) sawPendingOnDisk = true; }, 120);
  await sleep(waitMs);
  clearInterval(probe);
  runner.kill("SIGKILL"); await sleep(150);
  const turns = read(LOGF).split("===TURN===").filter(t => t.trim());
  return { turns, wakeTurns: turns.filter(t => t.includes("NEW BUS MESSAGE")),
    sends: [...sends], sawPendingOnDisk, pendingLeft: existsSync(PENDF), PENDF };
}

// ---- drill 1: two failed turns, then a good one. The message must survive both --------
{
  const r = await drill({ failTurns: 2 });
  ok("the wake message is delivered 3 times (2 crashes + 1 success), not once",
    r.wakeTurns.length === 3, `got ${r.wakeTurns.length} wake turn(s)`);
  ok("every redelivery still carries the ORIGINAL message text",
    r.wakeTurns.length >= 3 && r.wakeTurns.every(t => t.includes("prod is down, fix it now")));
  ok("the hub only ever handed the message out ONCE (nothing re-fired it)", served >= 2 && r.wakeTurns.length > 1);
  ok("attempt 2+ is labelled a REDELIVERY so the model doesn't redo finished work",
    r.wakeTurns.filter(t => t.includes("REDELIVERY")).length === 2,
    `${r.wakeTurns.filter(t => t.includes("REDELIVERY")).length} labelled`);
  ok("the undelivered batch is on disk while it is owed", r.sawPendingOnDisk);
  ok("the queue file is GONE once a turn finally exits 0", !r.pendingLeft);
  // Scoped to broadcasts: since #5684 the same state-change event ALSO goes direct to the
  // project orchestrator (direct = wake), so an unscoped count doubles.
  const held = r.sends.filter(s => s.to === "all" && /undelivered message/.test(s.text || ""));
  ok("the bus failure notice says how many messages the seat is holding",
    held.length === 2, `${held.length} notice(s): ${r.sends.map(s => s.text).join(" | ").slice(0, 220)}`);
  ok("recovery is announced once the batch finally lands",
    r.sends.some(s => /recovered/.test(s.text || "")));
}

// ---- drill 1b: PRODUCTION defaults — a failure must NOT retry instantly ----------------
// The bug this pins: with TRANTOR_RETRY_MS unset, "".split(",") -> [""] -> Number("") -> 0
// passed a >=0 filter, so the production ladder was [0] and a failing seat retry-STORMED
// (43 crashed turns in ~3 minutes, observed live on the first dsh seat). With the default
// 30s ladder, a 10s window must see exactly ONE delivery attempt.
{
  const r = await drill({ failTurns: 99, waitMs: 10000, noBackoffOverride: true });
  ok("with NO env override, a failed delivery does not retry within 10s (default ladder is 30s+)",
    r.wakeTurns.length === 1, `got ${r.wakeTurns.length} attempts in 10s`);
}

// ---- drill 2: a runner killed mid-outage still owes the message on restart -------------
{
  const r = await drill({ failTurns: 0, noMsg: true, waitMs: 6000,
    seedPending: { agent: "codex", project: "tt-redeliver", ts: Date.now(),
      wake: [{ from: "sasha@mac", to: "codex:tt-redeliver", text: "ESCALATION #4242: prod is down, fix it now" }], bcast: [] } });
  ok("a message left over from a killed runner is redelivered on the next boot",
    r.wakeTurns.length === 1, `got ${r.wakeTurns.length}`);
  ok("the restored message is the one that was owed",
    r.wakeTurns.some(t => t.includes("prod is down, fix it now")));
  ok("and it is cleared from disk once worked", !r.pendingLeft);
}

hub.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// trantor receipt-threading drill (#6987) — the REAL runner, a mock hub.
//
// notifyAssigners threads its outcome receipt onto a wake message id; which one decides whether
// the assigner's ledger closes the RIGHT contract. pendingWake is append-ordered, and first-wins
// picked the OLDEST id in the batch — in the ask flow the previous turn's original contract rather
// than the answer that released the turn, so the contract that actually woke the seat kept reading
// WAITING while the assigner's stop hook chased. The fix: the receipt carries the NEWEST wake id
// the runner holds for that assigner. This drill hands the runner two contracts from one assigner
// in a single batch and asserts the receipt names the newer one, never the stale one.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { drillEnv } from "../drill-env.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

console.log("# trantor receipt threading (#6987)");

// ---- mock hub: records every send, hands out the scripted wake batch once ------------
const sends = [];
let wakeBatch = [];
let served = 0;
const hub = http.createServer((req, res) => {
  let buf = ""; req.on("data", c => (buf += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x"), P = u.pathname;
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "POST" && P === "/send") { try { sends.push(JSON.parse(buf)); } catch {} return reply({ ok: true, id: 900 + sends.length }); }
    if (P === "/inbox") return reply({ messages: [], cursor: 0 });
    if (P === "/lessons") return reply({ lessons: [] });
    if (P === "/events") return reply({ events: [], latest: 0 });
    if (P === "/poll") {
      if (served++ === 0 && wakeBatch.length) return reply({ messages: wakeBatch.map(m => ({ ...m, to: u.searchParams.get("session") })), cursor: wakeBatch[wakeBatch.length - 1].id });
      return setTimeout(() => reply({ messages: [], cursor: wakeBatch[wakeBatch.length - 1]?.id || 0 }), 250);
    }
    return reply({ ok: true });
  });
});
await new Promise(r => hub.listen(0, "127.0.0.1", r));
const HUB = `http://127.0.0.1:${hub.address().port}`;

// ---- the REAL runner + a fake CLI whose success turns are substantive, not hollow ----
async function drill({ batch, waitMs = 8000 }) {
  sends.length = 0; served = 0;
  wakeBatch = batch.map(([id, text]) => ({ id, from: "sasha@mac", text, ts: Date.now() }));
  const work = mkdtempSync(join(tmpdir(), "tt-receipt-"));
  const HOME = join(work, "home");
  const BUS = join(HOME, ".agent-bus");
  mkdirSync(BUS, { recursive: true });
  const fakebin = join(work, "bin"); mkdirSync(fakebin, { recursive: true });
  const LOGF = join(work, "turns.log");
  const PROJ = "tt-receipt";
  writeFileSync(join(fakebin, "codex"), `#!/bin/sh
{ echo "===TURN==="; cat "$HOME/.agent-bus/turn-codex-${PROJ}.txt"; } >> "${LOGF}"
echo "the contract was read and worked: the fix landed in the worktree and the gate ran green,"
echo "so this turn consumed the wake message and cleared the pending queue."
exit 0
`);
  chmodSync(join(fakebin, "codex"), 0o755);
  const runner = spawn("node", ["bin/crew-runner.mjs", "codex", work], {
    cwd: process.cwd(), stdio: "ignore",
    env: { ...drillEnv(), HOME, PATH: `${fakebin}:${process.env.PATH}`,
      RELAY_URL: HUB, RELAY_AGENT: "codex", RELAY_PROJECT: PROJ,
      CREW_KICKOFF: "say hi and end your turn", TRANTOR_RETRY_MS: "1200" },
  });
  await sleep(waitMs);
  runner.kill("SIGKILL"); await sleep(150);
  const turns = read(LOGF).split("===TURN===").filter(t => t.trim());
  return { sends: [...sends], wakeTurns: turns.filter(t => t.includes("NEW BUS MESSAGE")) };
}

// ---- drill 1: two contracts from ONE assigner in one batch — the receipt names the NEWER one ----
{
  const r = await drill({ batch: [[7, "first: ship the fix"], [8, "second: review the drill"]] });
  ok("the seat actually ran the wake turn with both messages", r.wakeTurns.length === 1, `got ${r.wakeTurns.length}`);
  const receipts = r.sends.filter(s => s.kind === "receipt");
  ok("exactly one receipt went to the assigner", receipts.length === 1, JSON.stringify(r.sends.map(s => [s.to, s.kind, s.re])));
  ok("the receipt threads onto the NEWEST wake id (8)", receipts[0]?.re === 8, `re=${receipts[0]?.re}`);
  ok("the receipt never carries the stale id (7)", receipts[0]?.re !== 7);
}

// ---- drill 2: a single contract — the receipt names its own id, not 0/undefined ----------------
{
  const r = await drill({ batch: [[11, "only: write the notes"]] });
  const receipts = r.sends.filter(s => s.kind === "receipt");
  ok("single-contract wake still threads its own id", receipts.length === 1 && receipts[0]?.re === 11, JSON.stringify(receipts.map(s => s.re)));
}

hub.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

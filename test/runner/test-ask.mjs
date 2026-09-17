#!/usr/bin/env node
// #7756 relay_ask drill — a seat whose contract omits a fact ASKS instead of inventing: the card
// blocks with the question as its note, the wake stays owed on disk (no failure/backoff/park,
// ledger row "asked"), and the answer (re = the ask's id) resumes the SAME session. Hermetic:
// mock hub + fake codex driving the REAL runner; short TRANTOR_RETRY_MS catches a regressed hold.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { drillEnv } from "../drill-env.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
async function until(fn, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(150); }
  return null;
}

console.log("# trantor relay_ask drill (#7756)");

const PROJ = "tt-ask", SESSION = `codex:${PROJ}`, CARD = 4401;

// ---- mock hub: exactly-once delivery, the kind:ask card moves, and a /contracts view --------
// The card moves replicate hub/routes/messages.mjs (eb3d74d): kind:ask blocks the cited card
// with the question as its note; a reply threaded re = the ask's id moves it back to doing. It
// also keeps the hub's unified event log (by-actor, GET /events filters by/since) — what the
// runner's busActivitySince reads to tell a quiet-but-busy turn from an EMPTY one (#7759).
const messages = [];
const events = [];
let eventSeq = 0;
let nextId = 1;
const served = new Set();
const card = { id: CARD, project: PROJ, status: "doing", notes: [] };
const hub = http.createServer((req, res) => {
  let buf = ""; req.on("data", c => (buf += c));
  req.on("end", async () => {
    const u = new URL(req.url, "http://x"), P = u.pathname;
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "POST" && P === "/send") {
      let msg; try { msg = JSON.parse(buf); } catch { return reply({ ok: false }); }
      msg = { id: nextId++, ts: Date.now(), ...msg };
      messages.push(msg);
      events.push({ id: ++eventSeq, ts: msg.ts, type: "message", project: msg.project || "", by: msg.from || "" });
      const refs = [...new Set((String(msg.text || "").match(/#(\d{1,7})(?![0-9])/g) || []).map(s => Number(s.slice(1))))];
      if (msg.kind === "ask" && refs[0] === CARD && card.status !== "blocked") {
        card.status = "blocked"; card.notes.push({ by: msg.from, text: msg.text });
        events.push({ id: ++eventSeq, ts: msg.ts, type: "moved", project: PROJ, by: msg.from || "" });
      } else if (msg.re) {
        const opened = messages.find(m => m.id === Number(msg.re) && m.kind === "ask");
        if (opened && card.status === "blocked") {
          card.status = "doing"; card.notes.push({ by: msg.from, text: `answered: ${msg.text}` });
          events.push({ id: ++eventSeq, ts: msg.ts, type: "moved", project: PROJ, by: msg.from || "" });
        }
      }
      return reply({ ok: true, id: msg.id });
    }
    if (P === "/events") {
      const since = Number(u.searchParams.get("since") || 0);
      const by = u.searchParams.get("by") || "";
      const out = events.filter(e => e.id > since && (!by || e.by === by));
      return reply({ events: out, cursor: out.length ? out[out.length - 1].id : since, latest: eventSeq });
    }
    if (P === "/contracts") {
      const session = u.searchParams.get("session");
      const mine = messages.filter(m => m.from === session && m.to && m.to !== "all" && m.kind !== "status");
      const contracts = mine.map(m => ({
        id: m.id, to: m.to, kind: m.kind, text: m.text,
        answered: messages.some(r => r.kind !== "ask" && Number(r.re) === m.id),
        disposition: "waiting",
      }));
      return reply({ session, contracts, abandonedContracts: [], supersededContracts: [], ackContracts: [] });
    }
    if (P === "/inbox") return reply({ messages: [], cursor: 0 });
    if (P === "/lessons") return reply({ lessons: [] });
    if (P === "/policy") return reply({ links: [] });
    if (P === "/poll") {
      const session = u.searchParams.get("session");
      // exactly once, like the real hub — anything the seat loses after this, it loses.
      for (let i = 0; i < 5; i++) {
        const out = messages.filter(m => !served.has(m.id) && m.from !== session && (m.to === session || m.to === "all"));
        if (out.length) {
          for (const m of out) served.add(m.id);
          return reply({ messages: out, cursor: out[out.length - 1].id });
        }
        await sleep(100);
      }
      return reply({ messages: [], cursor: nextId - 1 });
    }
    return reply({ ok: true });
  });
});
await new Promise(r => hub.listen(0, "127.0.0.1", r));
const HUB = `http://127.0.0.1:${hub.address().port}`;
const post = (body) => fetch(`${HUB}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());

// ---- harness: the REAL runner + a fake `codex` that asks on the contract turn ---------------
const work = mkdtempSync(join(tmpdir(), "tt-ask-"));
const HOME = join(work, "home");
mkdirSync(join(HOME, ".agent-bus"), { recursive: true });
const fakebin = join(work, "bin"); mkdirSync(fakebin, { recursive: true });
const LOGF = join(work, "turns.log"), RUNLOG = join(work, "runner.log"), ASKJS = join(work, "ask.mjs");
const PENDF = join(HOME, ".agent-bus", `pending-codex-${PROJ}.json`);
const LEDGER = join(HOME, ".agent-bus", "logs", `codex-${PROJ}.jsonl`);
writeFileSync(ASKJS, `const [hub, from, to, text] = process.argv.slice(2);
const r = await fetch(hub + "/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from, to, kind: "ask", text }) });
const j = await r.json();
console.log("ask sent, id", j.id);
`);
// The contract names a value the seat cannot know. The fake CLI's ONLY move on that turn is the
// ask relay_ask would send — it writes no file, invents no DEPLOY_TARGET, prints UNDER the 120-
// char substantive floor (the codex-drill line is CLI chrome), and exits 0: if the ask did not
// count as bus activity, that turn would read EMPTY (#7759). The ANSWER turn is the opposite
// specimen — real resumed work, so it prints a substantive line like a real CLI would.
writeFileSync(join(fakebin, "codex"), `#!/bin/sh
P="$HOME/.agent-bus/turn-codex-${PROJ}.txt"
{ echo "===TURN==="; echo "ARGV: $*"; cat "$P"; } >> "${LOGF}"
if grep -q "NEW BUS MESSAGE" "$P"; then
  if grep -q "ANSWER:" "$P"; then
    echo "the answer landed — DEPLOY_TARGET is staging; writing it into the release config now and closing the contract out exactly as the assigner specified"
    exit 0
  fi
  node "${ASKJS}" "${HUB}" "${SESSION}" "sasha@mac" "❓ ask on #${CARD}: which value should DEPLOY_TARGET get? The contract does not say."
  echo "codex-drill: asked the assigner instead of inventing a value"
  exit 0
fi
echo "codex-drill: turn done"
exit 0
`);
chmodSync(join(fakebin, "codex"), 0o755);
const out = openSync(RUNLOG, "w");
const runner = spawn("node", ["bin/crew-runner.mjs", "codex", work], {
  cwd: process.cwd(), stdio: ["ignore", out, out],
  env: drillEnv({ HOME, PATH: `${fakebin}:${process.env.PATH}`,
    RELAY_URL: HUB, RELAY_AGENT: "codex", RELAY_PROJECT: PROJ,
    TRANTOR_RETRY_MS: "800",
    CREW_KICKOFF: "say hi and end your turn" }),
});
let runnerExit = null;
runner.on("exit", (c) => { runnerExit = c; });

const turns = () => read(LOGF).split("===TURN===").filter(t => t.trim());
const wakeTurns = () => turns().filter(t => t.includes("NEW BUS MESSAGE"));
const ledger = () => read(LEDGER).split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// ---- act 1: boot + kickoff ------------------------------------------------------------------
await until(() => turns().length >= 1);
ok("boot: the kickoff turn ran", turns().length >= 1);

// ---- act 2: a contract with a missing value arrives; the seat asks --------------------------
await post({ from: "sasha@mac", to: SESSION,
  text: `CONTRACT for you on #${CARD}: set DEPLOY_TARGET in the release config and ship it. (This contract deliberately omits the value.)` });
const askMsg = await until(() => messages.find(m => m.kind === "ask"));
ok("the seat asked its assigner (kind:ask reached the hub)", !!askMsg);
await until(() => read(RUNLOG).includes("holding the contract"));
await sleep(400);   // let the hold settle: pending file persisted, ledger row written

// ---- the held state --------------------------------------------------------------------------
ok("#7756: the card reads BLOCKED", card.status === "blocked", `status=${card.status}`);
ok("#7756: the card's note IS the question",
  card.notes.some(n => n.by === SESSION && n.text.includes("which value should DEPLOY_TARGET get")),
  JSON.stringify(card.notes));
ok("#7756: the asking turn invented no value — its only direct bus write is the ask",
  !messages.some(m => m.from === SESSION && m.to !== "all" && m.kind !== "ask"));
{
  const pend = JSON.parse(read(PENDF) || "{}");
  ok("#7756: the pending wake is still HELD on disk (not consumed by the clean exit)",
    Array.isArray(pend.wake) && pend.wake.length === 1 && pend.wake[0].text.includes(`#${CARD}`),
    read(PENDF).slice(0, 200));
  ok("#7756: the held queue names the ask it waits on (restart keeps holding)",
    pend.ask === askMsg?.id && pend.askTo === "sasha@mac", `ask=${pend.ask} askTo=${pend.askTo}`);
}
ok("#7756: the ledger row for the asking turn reads outcome \`asked\`, not \`completed\`",
  ledger().some(r => r.outcome === "asked"),
  ledger().map(r => r.outcome).join(","));
// Design check (#7756 × #7759): the asking turn touched no file and printed under the
// substantive floor, so ONLY the hub's event record of the ask (kind:ask send + card move,
// both by the seat — what busActivitySince reads) can keep it from reading EMPTY. If that
// chain breaks the row below flips to emptyTurn:true / outcome "empty" and the hold would
// ride the failure ladder instead.
{
  const askRow = ledger().find(r => r.outcome === "asked");
  ok("#7756: the asking turn counted as BUS ACTIVITY, not EMPTY (under the floor, no worktree change)",
    !!askRow && askRow.emptyTurn === false,
    JSON.stringify(ledger().map(r => ({ outcome: r.outcome, emptyTurn: r.emptyTurn }))));
  ok("#7756: no EMPTY notice went out for the asking turn",
    !messages.some(m => String(m.text || "").includes("EMPTY turn") && m.from === SESSION));
}
ok("#7756: no park, no failure notice — the failure ladder never saw the ask",
  !messages.some(m => /PARKED|FAILED|retrying in/.test(String(m.text || "")) && m.from === SESSION),
  messages.filter(m => m.from === SESSION).map(m => m.text).join(" | ").slice(0, 200));
ok("#7756: no premature \`✅ done\` was reported for the asking turn",
  !messages.some(m => String(m.text || "").startsWith("✅ done")));

// The ladder is 800ms here: 3s of silence = ~4 rungs on which a regressed hold WOULD redeliver.
await sleep(3000);
ok("#7756: the held wake is NEVER redelivered while the answer is owed",
  wakeTurns().length === 1, `got ${wakeTurns().length} wake turn(s)`);
ok("#7756: deliveryFails never bumped (no REDELIVERY label, no retry notice)",
  !turns().some(t => t.includes("REDELIVERY")));
ok("#7756: the runner is still alive and polling (a park would have exited or announced)",
  runnerExit === null);

// ---- act 3: the assigner answers (re = the ask's id); the seat resumes -----------------------
await post({ from: "sasha@mac", to: SESSION, re: askMsg.id, text: "ANSWER: DEPLOY_TARGET is staging." });
await until(() => wakeTurns().length >= 2);
await until(() => !existsSync(PENDF) || read(RUNLOG).includes("✅ done") || messages.some(m => String(m.text || "").startsWith("✅ done")), 10000);
await sleep(400);

const resumed = wakeTurns()[1] || "";
ok("#7756: the answer releases the hold — the seat resumes with the SAME session (resume --last)",
  resumed.includes("resume --last"), resumed.split("\n")[1] || "");
ok("#7756: the resumed turn reads the ORIGINAL contract re-attached above the answer",
  resumed.includes(`#${CARD}`) && resumed.includes("ANSWER: DEPLOY_TARGET is staging"));
ok("#7756: the resume is not labelled a redelivery (the ladder was never involved)",
  !resumed.includes("REDELIVERY"));
ok("#7756: the card is DOING again once the answer lands", card.status === "doing", `status=${card.status}`);
ok("#7756: the queue is cleared once the resumed turn exits 0", !existsSync(PENDF));
ok("#7756: the assigner gets the done notice only after the REAL work turn",
  messages.some(m => String(m.text || "").startsWith("✅ done")));

runner.kill("SIGKILL"); await sleep(150);
hub.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

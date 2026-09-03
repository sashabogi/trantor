#!/usr/bin/env node
// trantor wake-policy drill (#6134) — proves the two rules that cut the fleet's turn count:
//
//   1. A TURN COSTS A SESSION, so only a contract or a bounce buys one. A message sent with
//      wake:false batches into the next turn's context, and so does a direct message that carries
//      neither a card ref nor an instruction (the safety net for senders that never set the flag).
//   2. ONE SESSION PER CARD. A wake naming a different card starts a FRESH CLI session instead of
//      resuming — a seat that resumes forever replays every card it ever worked (qwen: 85.7M
//      tokens at 96.7% cached on 09-02).
//
// Hermetic: a mock hub (never touches the real ~/.agent-bus/bus.json) + a fake CLI that records
// every turn and how it was invoked, driving the REAL bin/crew-runner.mjs.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { drillEnv } from "./drill-env.mjs";
import { cardRef, carriesWork, parseTurnTokens, parseResetAt, quotaSpent, reasonWithBalances } from "./lib/turn-policy.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

console.log("# trantor wake-policy drill");

// ---- unit: the policy itself, without a hub ---------------------------------------------------
console.log("\n## the rules");
{
  ok("a card ref is the session's card", cardRef("bounce on #6134, easy") === 6134);
  ok("a plain sentence names no card", cardRef("thanks, got it") === 0);
  ok("a card ref alone is work", carriesWork("look at #6134"));
  ok("an imperative alone is work", carriesWork("resume where you left off"));
  ok("an ack is NOT work", !carriesWork("thanks, acknowledged"));
  ok("a queue note is NOT work", !carriesWork("noted, I will queue that behind the current one"));

  ok("codex's usage line is read", parseTurnTokens("thinking...\ntokens used: 12,345\ndone") === 12345);
  ok("the LAST running total wins", parseTurnTokens("tokens used 100\ntokens used 4,200") === 4200);
  ok("a CLI that prints no usage reports 0, not a guess", parseTurnTokens("done. exit 0") === 0);

  const now = Date.parse("2026-09-03T00:00:00Z");
  const abs = parseResetAt("You've hit your usage limit. Try again at Sep 3rd, 2026 3:34 AM", now);
  ok("codex's reset time is parsed off its own wall message", abs > now, `got ${abs}`);
  ok("a relative reset is parsed too", parseResetAt("try again in 45 minutes", now) === now + 45 * 60000);
  ok("no reset time means 0, never a made-up one", parseResetAt("API Error: 529 overloaded", now) === 0);

  ok("a spent quota row reads spent", quotaSpent([{ ok: true, kind: "quota", remainingPct: 0 }]));
  ok("a locked usage window reads spent", quotaSpent([{ ok: true, kind: "windows", windows: [{ usedPct: 100 }] }]));
  ok("a healthy row does not", !quotaSpent([{ ok: true, kind: "quota", remainingPct: 40 }]));
  // #6131: the qwen shape — the seat did not error, it went quiet with its plan spent.
  ok("#6131: a silent turn on a spent plan is EXHAUSTED, not a crash",
    reasonWithBalances("empty-output", [{ ok: true, kind: "quota", remainingPct: 0 }]) === "exhausted");
  ok("a silent turn on a healthy plan stays empty-output",
    reasonWithBalances("empty-output", [{ ok: true, kind: "quota", remainingPct: 80 }]) === "empty-output");
  ok("a backend error is never re-read as exhaustion",
    reasonWithBalances("backend-error", [{ ok: true, kind: "quota", remainingPct: 0 }]) === "backend-error");
}

// ---- the runner, against a mock hub -----------------------------------------------------------
// Hands out one batch of messages, then stays silent. Whatever the seat does with them is the test.
let queued = [], served = 0;
const hub = http.createServer((req, res) => {
  let buf = ""; req.on("data", c => (buf += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x"), P = u.pathname;
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (P === "/inbox") return reply({ messages: [], cursor: 0 });
    if (P === "/lessons") return reply({ lessons: [] });
    if (P === "/poll") {
      if (served++ === 0 && queued.length) {
        return reply({ messages: queued.map((m, i) => ({ id: i + 1, ts: Date.now(), to: u.searchParams.get("session"), from: "sasha@mac", ...m })), cursor: 1 });
      }
      return setTimeout(() => reply({ messages: [], cursor: 1 }), 250);
    }
    return reply({ ok: true });
  });
});
await new Promise(r => hub.listen(0, "127.0.0.1", r));
const HUB = `http://127.0.0.1:${hub.address().port}`;

// The fake CLI logs one record per turn: how it was invoked (`exec` = a fresh session, `resume` =
// continuing one) and the prompt it was handed. That is exactly what both rules are about.
async function drill(messages, { waitMs = 7000 } = {}) {
  queued = messages; served = 0;
  const work = mkdtempSync(join(tmpdir(), "tt-wake-"));
  const HOME = join(work, "home");
  mkdirSync(join(HOME, ".agent-bus"), { recursive: true });
  const fakebin = join(work, "bin"); mkdirSync(fakebin, { recursive: true });
  const LOGF = join(work, "turns.log");
  const PROJ = "tt-wake";
  writeFileSync(join(fakebin, "codex"), `#!/bin/sh
P="$HOME/.agent-bus/turn-codex-${PROJ}.txt"
{ echo "===TURN=== mode=$1"; cat "$P"; } >> "${LOGF}"
echo "codex-drill: turn done"
exit 0
`);
  chmodSync(join(fakebin, "codex"), 0o755);

  const runner = spawn("node", ["bin/crew-runner.mjs", "codex", work], {
    cwd: process.cwd(), stdio: "ignore",
    env: { ...drillEnv(), HOME, PATH: `${fakebin}:${process.env.PATH}`,
      RELAY_URL: HUB, RELAY_AGENT: "codex", RELAY_PROJECT: PROJ,
      CREW_KICKOFF: "say hi and end your turn" },
  });
  await sleep(waitMs);
  runner.kill("SIGKILL"); await sleep(150);

  const turns = read(LOGF).split("===TURN===").filter(t => t.trim());
  return {
    turns,
    wakeTurns: turns.filter(t => t.includes("NEW BUS MESSAGE")),
    // `codex exec resume` passes "resume" as argv[1]; a fresh `codex exec` does not.
    fresh: turns.filter(t => t.includes("NEW BUS MESSAGE") && !/^ mode=resume/.test(t)),
    resumed: turns.filter(t => t.includes("NEW BUS MESSAGE") && /^ mode=resume/.test(t)),
  };
}

// ---- drill 1: wake:false batches, a contract wakes --------------------------------------------
console.log("\n## a turn costs a session");
{
  const r = await drill([
    { text: "queued behind two other things, will get to it", wake: false },
    { text: "contract: work card #7001 now" },
  ]);
  ok("the contract still buys its turn", r.wakeTurns.length === 1, `${r.wakeTurns.length} wake turn(s)`);
  ok("the wake:false note rides along as CONTEXT, not as its own turn",
    r.wakeTurns.length === 1 && r.wakeTurns[0].includes("queued behind two other things"),
    r.wakeTurns[0]?.slice(0, 300));
}
{
  const r = await drill([{ text: "thanks, acknowledged", wake: false }]);
  ok("a wake:false message ALONE never starts a turn", r.wakeTurns.length === 0, `${r.wakeTurns.length} wake turn(s)`);
}
{
  // The safety net: the sender set no flag at all, and the message is plainly not work.
  const r = await drill([{ text: "thanks, acknowledged" }]);
  ok("an ack with no flag set batches on its shape alone", r.wakeTurns.length === 0, `${r.wakeTurns.length} wake turn(s)`);
}
{
  const r = await drill([{ text: "#7002 is bounced: the gate is red" }]);
  ok("a bounce naming a card wakes", r.wakeTurns.length === 1, `${r.wakeTurns.length} wake turn(s)`);
}

// ---- drill 2: two cards -> two sessions -------------------------------------------------------
console.log("\n## one session per card");
{
  const r = await drill([{ text: "contract: card #7010, build the thing" }], { waitMs: 5000 });
  ok("the first card starts a FRESH session (it is not the kickoff's session)",
    r.fresh.length === 1 && r.resumed.length === 0, `fresh=${r.fresh.length} resumed=${r.resumed.length}`);
  ok("the fresh session is told it has no memory and where its card is",
    r.wakeTurns[0]?.includes("FRESH SESSION for card #7010") && r.wakeTurns[0]?.includes("relay_board with card:7010"),
    r.wakeTurns[0]?.slice(0, 300));
}
{
  // Both messages arrive in ONE batch, so they are one turn on the first card; the SECOND card is
  // what a later wake would carry. Two separate batches is the honest shape of that.
  const first = await drill([{ text: "contract: card #7020, build the thing" }], { waitMs: 5000 });
  ok("card A runs fresh", first.fresh.length === 1, `fresh=${first.fresh.length}`);

  const second = await drill([
    { text: "contract: card #7030, build the other thing" },
    { text: "contract: card #7030 again, same card" },
  ], { waitMs: 5000 });
  ok("two wakes citing the SAME card are one session, not two",
    second.wakeTurns.length === 1 && second.fresh.length === 1,
    `wakes=${second.wakeTurns.length} fresh=${second.fresh.length}`);
}

// ---- the flag survives the REAL hub -----------------------------------------------------------
// The runner legs above prove what a seat does with `wake:false`; this proves the field actually
// gets there. Stored only when false, so every client that predates the flag is untouched.
console.log("\n## the hub carries the flag");
{
  const { spawn: spawnHub } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "tt-wake-hub-"));
  mkdirSync(join(dir, ".agent-bus"), { recursive: true });
  const PORT = 47948;
  const proc = spawnHub("node", ["hub.mjs"], {
    cwd: process.cwd(),
    env: { ...drillEnv(), RELAY_DATA_DIR: dir, HOME: dir, RELAY_PORT: String(PORT), PORT: String(PORT), TRANTOR_NO_UPDATE_CHECK: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await sleep(1200);
  const BASE = `http://127.0.0.1:${PORT}`;
  const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json()).catch(e => ({ error: String(e) }));
  const get = (p) => fetch(BASE + p).then(r => r.json()).catch(e => ({ error: String(e) }));

  await post("/register", { session: "codex:wp", project: "wp", status: "active in wp" });
  await post("/send", { from: "host:wp", to: "codex:wp", project: "wp", text: "queued behind the current card", wake: false });
  await post("/send", { from: "host:wp", to: "codex:wp", project: "wp", text: "contract: card #9001" });
  const { messages } = await get(`/inbox?session=${encodeURIComponent("codex:wp")}&since=0`);
  const batched = (messages || []).find(m => /queued behind/.test(m.text || ""));
  const waking = (messages || []).find(m => /#9001/.test(m.text || ""));
  ok("the hub stores wake:false on the message", batched?.wake === false, JSON.stringify(batched));
  ok("and leaves it ABSENT on an ordinary send, so older clients are unchanged",
    waking && waking.wake === undefined, JSON.stringify(waking));
  proc.kill("SIGKILL");
}

hub.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

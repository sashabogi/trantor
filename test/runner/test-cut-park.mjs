#!/usr/bin/env node
// trantor cut-chain park drill (#7914) — a seat cut twice in a row must not go silent. The box cut
// and its cut follow-up are two turns inside ONE delivery attempt, so the two-failed-attempts rung
// never saw them and the orchestrator read "live, last turn failed" for 46 minutes.
import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { drillEnv } from "../drill-env.mjs";
import { seatWhy } from "../../lib/seat-why.mjs";
import { CUT_CHAIN_PARK_MIN, cutChainEvidence, isBoundedPark } from "../../lib/turn-policy.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

console.log("# trantor cut-chain park drill (#7914)");

// ---- unit: the evidence line and the bounded-park rule ----------------------------------------
console.log("\n## what a park notice owes its reader");
{
  const chain = [
    { turn: 12, trigger: "direct message", exit: 137, signal: "SIGKILL", boxMs: 1200000, extensions: 0 },
    { turn: 13, trigger: "time-box follow-up", exit: 141, signal: "SIGPIPE", boxMs: 1800000, extensions: 1 },
  ];
  const line = cutChainEvidence(chain);
  ok("the evidence counts the chain and names its most recent turn",
    /^2 cut turns, last: /.test(line) && /turn 13/.test(line) && !/turn 12/.test(line), line);
  ok("...with that turn's exit code and signal", /exit 141 \(SIGPIPE\)/.test(line), line);
  ok("...and the cut reason, box and extensions included",
    /cut at the 30m box after 1 liveness extension/.test(line), line);
  ok("a single-turn chain needs no count in front of it",
    /^turn 12 /.test(cutChainEvidence([chain[0]])), cutChainEvidence([chain[0]]));
  ok("a seconds-long box is named in seconds, never rounded to 0m",
    /cut at the 3s box/.test(cutChainEvidence([{ turn: 1, trigger: "message", exit: 137, boxMs: 3000 }])));
  ok("no cuts, no evidence", cutChainEvidence([]) === "" && cutChainEvidence(null) === "");
  ok("two cut turns are the park threshold", CUT_CHAIN_PARK_MIN === 2);
  ok("a time-box park is bounded — a timer can clear it", isBoundedPark("time-box"));
  ok("an exhausted or auth park is not: no window makes a spent plan usable",
    !isBoundedPark("exhausted") && !isBoundedPark("auth"));
}

// ---- unit: seat-why reads the park record off disk --------------------------------------------
console.log("\n## trantor seat-why names the park");
{
  const dir = mkdtempSync(join(tmpdir(), "tt-park-why-"));
  mkdirSync(join(dir, "logs"), { recursive: true });
  writeFileSync(join(dir, "crew-windows.txt"), "ttpark\therdr\tglm\tpane-1\n");
  writeFileSync(join(dir, "logs", "glm-ttpark.jsonl"),
    JSON.stringify({ ts: Date.now() - 60000, agent: "glm", project: "ttpark", turn: 3, trigger: "message", exit: 137, cut: true }) + "\n");
  const live = seatWhy("ttpark", "glm", { dir, pidCheck: () => [4242] });
  ok("with no park record a live seat still reads live", live.state === "live", JSON.stringify(live));

  const until = Date.now() + 9 * 60 * 1000;
  writeFileSync(join(dir, "park-glm-ttpark.json"), JSON.stringify({
    session: "glm:ttpark", agent: "glm", project: "ttpark", reason: "time-box", bounded: true,
    until, held: 2, ts: Date.now() - 60000,
    evidence: "turn 12 (direct message) exit 137 (SIGKILL) — cut at the 20m box · turn 13 (time-box follow-up) exit 141 (SIGPIPE) — cut at the 20m box",
  }));
  const parked = seatWhy("ttpark", "glm", { dir, pidCheck: () => [4242] });
  ok("a parked seat reads PARKED, not 'live, last turn failed'", parked.state === "parked", JSON.stringify(parked));
  ok("...the why names the reason and the held queue", /PARKED \(time-box\)/.test(parked.why) && /holding 2 messages/.test(parked.why), parked.why);
  ok("...the why carries the cut evidence", /turn 12/.test(parked.why) && /turn 13/.test(parked.why), parked.why);
  ok("...the advice names the resume time and the way out",
    /parked until /.test(parked.advice) && /direct message/.test(parked.advice), parked.advice);
  ok("...and never tells the operator to watch it or swap", !/watch it or swap/i.test(parked.advice), parked.advice);

  writeFileSync(join(dir, "park-glm-ttpark.json"), JSON.stringify({
    reason: "exhausted", bounded: false, until: Number.MAX_SAFE_INTEGER, held: 1, ts: Date.now(),
  }));
  const walled = seatWhy("ttpark", "glm", { dir, pidCheck: () => [4242] });
  ok("an unbounded park says it has no timer", walled.state === "parked" && /no timer/.test(walled.advice), walled.advice);

  writeFileSync(join(dir, "park-glm-ttpark.json"), JSON.stringify({ reason: "time-box", bounded: true, until: Date.now() - 1000, held: 1, ts: Date.now() - 60000 }));
  const expired = seatWhy("ttpark", "glm", { dir, pidCheck: () => [4242] });
  ok("a park past its window is over — the seat reads live again", expired.state === "live", JSON.stringify(expired));
}

// ---- mock hub: one direct contract, then a second on demand -----------------------------------
const sends = [];
let handed = 0, knockAt = 0;
const CONTRACT = { id: 7, from: "sasha@mac", text: "contract: work card #7914 now", ts: Date.now() };
const KNOCK = { id: 8, from: "MacBook-Pro-M1:ttcut", text: "contract: the park is noted, take a turn on #7914 now", ts: Date.now() };
const hub = http.createServer((req, res) => {
  let buf = ""; req.on("data", c => (buf += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x"), P = u.pathname;
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "POST" && P === "/send") {
      try { sends.push(JSON.parse(buf)); } catch {}
      return reply({ ok: true, id: sends.length });
    }
    if (P === "/events") return reply({ events: [], cursor: 0, latest: 0 });
    if (P === "/inbox") return reply({ messages: [], cursor: 0 });
    if (P === "/lessons") return reply({ lessons: [] });
    if (P === "/policy") return reply({ links: [], autonomy: { "*": 1 } });
    if (P === "/poll") {
      const session = u.searchParams.get("session");
      if (handed === 0) { handed = 1; return reply({ messages: [{ ...CONTRACT, to: session }], cursor: 1 }); }
      // The knock is handed out only once the park exists, so the drill is testing an END to a
      // park and never a message that raced it.
      if (knockAt && handed === 1 && Date.now() >= knockAt) { handed = 2; return reply({ messages: [{ ...KNOCK, to: session }], cursor: 2 }); }
      return setTimeout(() => reply({ messages: [], cursor: handed }), 200);
    }
    return reply({ ok: true });
  });
});
await new Promise(r => hub.listen(0, "127.0.0.1", r));
const HUB = `http://127.0.0.1:${hub.address().port}`;

// ---- harness: the REAL runner + a fake `codex` that outruns a 3-second box --------------------
// The kickoff answers instantly; only a wake turn and the time-box follow-up sleep past the box, so
// the chain the drill parks on is exactly the two cut turns and nothing else. The CLI prints while
// it sleeps, so the watchdog sees liveness and this is a BOX cut, never a stall (#7752).
const PROJ = "ttcut";
const root = mkdtempSync(join(tmpdir(), "tt-cutpark-"));
const HOME = join(root, "home");
const REPO = join(root, "repo");
const BUS = join(HOME, ".agent-bus");
mkdirSync(BUS, { recursive: true });
mkdirSync(REPO, { recursive: true });
execSync("git init -q", { cwd: REPO });
const fakebin = join(root, "bin"); mkdirSync(fakebin, { recursive: true });
const LOGF = join(root, "turns.log");
writeFileSync(join(fakebin, "codex"), `#!/bin/sh
P="$HOME/.agent-bus/turn-codex-${PROJ}.txt"
{ echo "===TURN==="; cat "$P"; } >> "${LOGF}"
echo "OpenAI Codex v2.3.4"
if grep -qE "NEW BUS MESSAGE|cut at the time box" "$P"; then
  i=0
  while [ $i -lt 30 ]; do echo "working on the contract, still alive"; sleep 1; i=$((i+1)); done
fi
echo "the drill CLI answered without touching the worktree, which is all this turn had to do"
exit 0
`);
chmodSync(join(fakebin, "codex"), 0o755);

const PENDF = join(BUS, `pending-codex-${PROJ}.json`);
const PARKF = join(BUS, `park-codex-${PROJ}.json`);
const JSONL = join(BUS, "logs", `codex-${PROJ}.jsonl`);
const runner = spawn("node", ["bin/crew-runner.mjs", "codex", REPO], {
  cwd: process.cwd(), stdio: "ignore",
  env: {
    ...drillEnv({ TRANTOR_NO_DESKTOP_NOTIFY: "1" }), HOME, PATH: `${fakebin}:${process.env.PATH}`,
    RELAY_URL: HUB, RELAY_AGENT: "codex", RELAY_PROJECT: PROJ,
    CREW_KICKOFF: "say hi and end your turn",
    TRANTOR_TURN_MAX_MS: "3000",
    // Equal to the box: no liveness extension, so the cut lands on the drill's clock (#7761).
    TRANTOR_TURN_CEILING_MS: "3000",
    // Far past the box, so a chatty CLI is never read as a stall.
    TRANTOR_TURN_WATCHDOG_MS: "600000",
    // The park window the drill asserts on, and a backoff short enough that a park is visibly
    // NOT the backoff: if the ladder were still driving this, the seat would retry in 1.2s.
    TRANTOR_PARK_WINDOW_MS: "600000",
    TRANTOR_RETRY_MS: "1200",
  },
});

// kickoff, then TWO cut chains — each a wake turn and its time-box follow-up, both bounded by the
// 3s box, with the 1.2s ladder between them. The second failed chain is #6289's park threshold.
await sleep(26000);
const parkRec = (() => { try { return JSON.parse(read(PARKF)); } catch { return null; } })();
const parkMsgs = sends.filter(s => /PARKED/.test(s.text || ""));
const toAssigner = parkMsgs.filter(s => s.to === "sasha@mac");
const toRoom = parkMsgs.filter(s => s.to === "all");
const toOrch = parkMsgs.filter(s => s.to && s.to !== "all" && s.to !== "sasha@mac");
const rows = read(JSONL).split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } });
const cutRows = rows.filter(r => r.cut);

console.log("\n## two cut chains in a row park the seat");
ok("the box cut every wake turn AND every follow-up — four cut telemetry rows",
  cutRows.length >= 4, `${cutRows.length} cut row(s): ${JSON.stringify(cutRows.map(r => ({ turn: r.turn, trigger: r.trigger, exit: r.exit })))}`);
ok("the follow-up is the second cut, by trigger",
  cutRows.some(r => r.trigger === "time-box follow-up"), JSON.stringify(cutRows.map(r => r.trigger)));
ok("#7914: the chain PARKED the seat — the notice went out",
  parkMsgs.length > 0, `${sends.length} send(s): ${JSON.stringify(sends.map(s => String(s.text || "").slice(0, 70)))}`);
ok("#7914: every park notice names the reason as time-box, not api-error or exhausted",
  parkMsgs.length > 0 && parkMsgs.every(s => /\(time-box\)/.test(s.text || "") && !/api-error|exhausted/.test(s.text || "")),
  parkMsgs.map(s => String(s.text).slice(0, 90)).join("\n          "));
ok("#7914: the wake is NOT consumed — the seat still owes its contract", existsSync(PENDF));
// #6289 owns the threshold and keeps it: the chain retries ONCE and the second failed chain parks,
// so the contract is attempted exactly twice and the park replaces the third attempt.
const attempts = read(LOGF).split("===TURN===").filter(t => /NEW BUS MESSAGE/.test(t)).length;
ok("#6289: the contract is attempted exactly TWICE — the park replaces the third attempt",
  attempts === 2, `${attempts} wake attempt(s) before the park`);

console.log("\n## the notice names its evidence, on the bus");
ok("#7914: the ASSIGNER of the held contract is told directly, not only the room",
  toAssigner.length === 1, `${toAssigner.length} notice(s) to sasha@mac`);
ok("#7914: the orchestrator gets the park as a direct alert too",
  toOrch.length >= 1, JSON.stringify(toOrch.map(s => s.to)));
ok("#7914: the room hears it once", toRoom.length === 1, `${toRoom.length} broadcast(s)`);
const assignerText = String(toAssigner[0]?.text || "");
// notifyAssigners caps the line at 280 chars, so a four-turn chain is named by its COUNT plus its
// most recent turn — enough to see the shape, short enough that the resume time and the ask survive.
const shown = cutRows.slice(-1);
ok("#7914: the notice counts the whole chain and names its most recent turn",
  cutRows.length >= 4 && assignerText.includes(`${cutRows.length} cut turns, last:`)
  && shown.every(r => assignerText.includes(`turn ${r.turn} `)), assignerText);
ok("#7914: ...with the exit code that turn actually died with",
  shown.length === 1 && assignerText.includes(`exit ${shown[0].exit}`), assignerText);
ok("#7914: ...and the cut reason, naming the box that ended it",
  /cut at the 3s box/.test(assignerText), assignerText);
ok("#7914: the whole notice fits the 280-char bus line — nothing actionable is truncated away",
  assignerText.length <= 280 && /asked: /.test(assignerText), `${assignerText.length} chars`);
ok("#7914: the notice names when the park lifts", /resumes /.test(assignerText), assignerText);

console.log("\n## the park is bounded, on disk, and seat-why reads it");
ok("#7914: a park record exists for the seat", !!parkRec, read(PARKF));
ok("#7914: it is bounded and its window is ahead of now",
  parkRec && parkRec.bounded === true && parkRec.until > Date.now(), JSON.stringify(parkRec));
ok("#7914: it carries the same evidence as the notice",
  parkRec && !!parkRec.evidence && assignerText.includes(parkRec.evidence), parkRec && parkRec.evidence);
{
  const why = seatWhy(PROJ, "codex", { dir: BUS, pidCheck: () => [runner.pid] });
  ok("#7914: seat-why says PARKED (time-box) with the resume time",
    why.state === "parked" && /PARKED \(time-box\)/.test(why.why) && /parked until /.test(why.advice),
    JSON.stringify(why));
}

console.log("\n## a fresh direct message ends the park");
const turnsBefore = read(LOGF).split("===TURN===").filter(t => t.trim()).length;
knockAt = Date.now();
await sleep(9000);
runner.kill("SIGKILL"); await sleep(200);
const turns = read(LOGF).split("===TURN===").filter(t => t.trim());
ok("#7914: the knock bought a turn — it did not queue behind the 10-minute window",
  turns.length > turnsBefore, `${turnsBefore} turn(s) before the knock, ${turns.length} after`);
ok("#7914: the turn the knock bought carried the held contract, still owed",
  turns.slice(turnsBefore).some(t => /#7914/.test(t)), turns.slice(turnsBefore).join("\n").slice(0, 400));

hub.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

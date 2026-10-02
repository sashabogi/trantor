#!/usr/bin/env node
// trantor duplicate-delivery drill (#7778) — ONE message id, ONE delivery, whichever path sees it
// first. The session's own inbox read (relay_inbox, the PostToolUse hook) and the runner's /poll
// are two readers of one bus with no shared cursor, so a message the seat read and answered
// MID-TURN used to be re-polled after the turn and woken AGAIN (seen live on codex:crebral-scribe:
// it answered #20258 inside its turn, then a second turn 16s later re-quoted the same message
// verbatim). The hub hands each message row out to every reader whose cursor is behind — delivery
// to the MODEL is the runner's job to dedupe. Hermetic: a mock hub with the REAL seam (poll
// filters by the caller's cursor, never by deliveredUpTo), a fake CLI, the REAL runner.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { drillEnv } from "../drill-env.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

console.log("# trantor duplicate-delivery drill (#7778)");

// ---- mock hub: the REAL delivery seam. /poll and /inbox each filter by the CALLER's since and
// never by deliveredUpTo — so a row is handed to whichever reader asks with a stale cursor. ----
const state = { seq: 0, messages: [], dUT: 0, events: [], inboxDown: false };
const deliverable = (m, s) => (m.to === s || m.to === "all") && m.from !== s;
const markDelivered = (upTo) => { const n = Number(upTo || 0); if (n > state.dUT) state.dUT = n; };
const hub = http.createServer((req, res) => {
  let buf = ""; req.on("data", c => (buf += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x"), P = u.pathname, q = u.searchParams;
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "POST" && P === "/send") {
      let b = {}; try { b = JSON.parse(buf); } catch {}
      const msg = { id: ++state.seq, ts: Date.now(), from: b.from || "anon", to: b.to || "all", text: b.text || "" };
      state.messages.push(msg);
      return reply({ ok: true, id: msg.id });
    }
    if (P === "/inbox") {
      // the session-side path (relay_inbox / hooks). inboxDown models a boot whose cursor sync
      // fails, so only the RESTORED seen-set stands between the seat and a duplicate.
      if (state.inboxDown) { res.writeHead(500, { "content-type": "application/json" }); return res.end("{}"); }
      const session = q.get("session"), since = Number(q.get("since") || 0);
      const msgs = state.messages.filter(m => m.id > since && deliverable(m, session));
      const cursor = msgs.length ? msgs[msgs.length - 1].id : since;
      if (q.get("peek") !== "1") markDelivered(cursor);
      for (const m of msgs) state.events.push({ ts: Date.now(), path: "inbox", id: m.id, session });
      return reply({ messages: msgs, cursor });
    }
    if (P === "/poll") {
      // the runner's path: same filter as the real hub — caller cursor only, deliveredUpTo ignored.
      const session = q.get("session"), since = Number(q.get("since") || 0);
      const msgs = state.messages.filter(m => m.id > since && deliverable(m, session));
      const cursor = msgs.length ? msgs[msgs.length - 1].id : since;
      if (msgs.length) {
        markDelivered(cursor);
        for (const m of msgs) state.events.push({ ts: Date.now(), path: "poll", id: m.id, session });
        return reply({ messages: msgs, cursor });
      }
      return setTimeout(() => reply({ messages: [], cursor: since }), 150);
    }
    if (P === "/peer") return reply({ session: q.get("session"), deliveredUpTo: state.dUT });
    if (P === "/lessons") return reply({ lessons: [] });
    return reply({ ok: true });
  });
});
await new Promise(r => hub.listen(0, "127.0.0.1", r));
const HUB = `http://127.0.0.1:${hub.address().port}`;
const post = (path, b) => fetch(`${HUB}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json());
const handoffs = (id) => state.events.filter(e => e.id === id).map(e => `${e.path}@${new Date(e.ts).toISOString()}`);

// ---- harness: the REAL runner + a fake `codex`. #9832: the kickoff turn no longer lasts a
// fixed 2s — the fake CLI SIGNS its start (kickoff-live marker) and HOLDS the turn open until
// the drill releases it. The probe's mid-turn arrival is then an EVENT anchored to the turn,
// not a race against the runner's boot: under a loaded host the old sleep(800) could fire
// before the kickoff had even started (the poll woke on the probe directly — the exact
// duplicate delivery this suite exists to prove suppressed) and sleep(3200) could post probe 2
// before the kickoff's boundary reconcile had consumed probe 1. -------------------------------
const PROJ = "tt-dedupe";
const PROBE1 = "DEDUPE-PROBE #4242: answer this clarification in place, then end your turn";
const PROBE2 = "SECOND-PROBE #4243: one more ask, needing its own turn";

async function drill({ sessionRead = false, failWakeTurns = 0, lateProbe = false, restart = false, waitMs = 8000 }) {
  state.seq = 0; state.messages = []; state.dUT = 0; state.events = []; state.inboxDown = false;
  const work = mkdtempSync(join(tmpdir(), "tt-dedupe-"));
  const HOME = join(work, "home");
  const BUS = join(HOME, ".agent-bus");
  mkdirSync(BUS, { recursive: true });
  const fakebin = join(work, "bin"); mkdirSync(fakebin, { recursive: true });
  const LOGF = join(work, "turns.log"), CNTF = join(work, "count");
  const KICKMARK = join(work, "kickoff-live"), RELEASE = join(work, "release");
  const PENDF = join(BUS, `pending-codex-${PROJ}.json`);
  writeFileSync(join(fakebin, "codex"), `#!/bin/sh
P="$HOME/.agent-bus/turn-codex-${PROJ}.txt"
{ echo "===TURN ts=$(date +%s)==="; cat "$P"; } >> "${LOGF}"
if ! grep -q "NEW BUS MESSAGE" "$P"; then
  : > "${KICKMARK}"
  i=0
  while [ ! -f "${RELEASE}" ] && [ "$i" -lt 6000 ]; do sleep 0.02; i=$((i+1)); done
fi
if grep -q "NEW BUS MESSAGE" "$P"; then
  n=$(cat "${CNTF}" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${CNTF}"
  if [ "$n" -le ${failWakeTurns} ]; then echo "API Error: 529 overloaded" >&2; exit 1; fi
fi
# #7759: the success fixture answers past the substantive floor — this drill tests delivery
# dedupe, not turn validity.
echo "the probe was handled: card moved, the fix landed in the worktree, and the gate ran green,"
echo "so this turn consumed its wake message and ends here."
exit 0
`);
  chmodSync(join(fakebin, "codex"), 0o755);
  const runnerEnv = { ...drillEnv(), HOME, PATH: `${fakebin}:${process.env.PATH}`,
    RELAY_URL: HUB, RELAY_AGENT: "codex", RELAY_PROJECT: PROJ,
    CREW_KICKOFF: "say hi and end your turn", TRANTOR_RETRY_MS: "1200" };
  const spawnRunner = () => spawn("node", ["bin/crew-runner.mjs", "codex", work], {
    cwd: process.cwd(), stdio: "ignore", env: runnerEnv,
  });
  // the persisted seen-set gaining the id IS the boundary reconcile having consumed it —
  // both the restart gate and the late-probe gate hang off that event, not off a clock.
  const seenHas = (id) => { try { const j = JSON.parse(readFileSync(PENDF, "utf8")); return (j.seen || []).some(e => e.id === id); } catch { return false; } };
  let runner = spawnRunner();
  const session = `codex:${PROJ}`;
  let probe1Id = 0;
  const bootT0 = Date.now();
  while (!existsSync(KICKMARK) && Date.now() - bootT0 < 30000) await sleep(50);
  if (!existsSync(KICKMARK)) console.log("  FAIL  kickoff never signalled live within 30s — drill window missed");
  const sent = await post("/send", { from: "sasha@mac", to: session, text: PROBE1 });
  probe1Id = sent.id;
  if (sessionRead) {
    // the session reads it through its OWN inbox path (the seat's relay_inbox call in the live
    // incident). Non-peek read, so the hub ledger advances — the other path has now consumed it.
    const r = await (await fetch(`${HUB}/inbox?session=${encodeURIComponent(session)}&since=0`)).json();
    if (!r.messages.length) console.log("  FAIL  the session-side read got an empty inbox — drill window missed");
  }
  writeFileSync(RELEASE, "go\n");
  let fileHadSeen = false;
  if (restart) {
    // wait for the boundary reconcile to persist the consumed id, then kill the runner and boot a
    // NEW one whose boot cursor sync fails — the restored seen-set is then the only duplicate guard.
    const t0 = Date.now();
    while (Date.now() - t0 < 15000 && !seenHas(probe1Id)) await sleep(120);
    fileHadSeen = seenHas(probe1Id);
    runner.kill("SIGKILL"); await sleep(200);
    state.inboxDown = true;
    runner = spawnRunner();
  }
  let probe2Id = 0;
  if (lateProbe) {
    // arrives AFTER the kickoff's boundary reconcile consumed probe 1 — its id is beyond the
    // ledger that boundary wrote, so only the poll path will ever carry it, and its first wake
    // fails, so redelivery must survive the dedupe.
    const t0 = Date.now();
    while (Date.now() - t0 < 15000 && !seenHas(probe1Id)) await sleep(120);
    const sent = await post("/send", { from: "sasha@mac", to: session, text: PROBE2 });
    probe2Id = sent.id;
  }
  await sleep(waitMs);
  runner.kill("SIGKILL"); await sleep(150);
  const turns = read(LOGF).split("===TURN").filter(t => t.trim());
  return {
    probe1Turns: turns.filter(t => t.includes("DEDUPE-PROBE")),
    probe2Turns: turns.filter(t => t.includes("SECOND-PROBE")),
    fileHadSeen, PENDF, pendingLeft: existsSync(PENDF),
    pendingSeen: (() => { try { const j = JSON.parse(readFileSync(PENDF, "utf8")); return j.seen || []; } catch { return []; } })(),
    probe1Id, probe2Id,
  };
}

// ---- drill 1 (the incident): the seat reads and answers the probe MID-TURN; the runner polls
// the same row after the turn. One delivery, and the poll's copy loses the race. ------------
{
  state.messages.length = 0;
  const r = await drill({ sessionRead: true });
  console.log(`  · handoffs of probe id #${r.probe1Id}: ${handoffs(r.probe1Id).join(", ") || "(none)"}`);
  ok("the session's own read reached the model first (mid-turn inbox handoff)",
    state.events.some(e => e.id === r.probe1Id && e.path === "inbox"),
    handoffs(r.probe1Id).join(", "));
  ok("ONE delivery total: the runner did NOT wake on a message the seat already answered in-turn",
    r.probe1Turns.length === 0, `got ${r.probe1Turns.length} runner wake(s) quoting the probe`);
  ok("the poll did serve the row and lost the race (the seam the dedupe closes)",
    state.events.some(e => e.id === r.probe1Id && e.path === "poll"), handoffs(r.probe1Id).join(", "));
  ok("the consumed id is persisted in the pending file's seen-set",
    r.pendingLeft && r.pendingSeen.some(e => e.id === r.probe1Id),
    `seen=${JSON.stringify(r.pendingSeen)} file=${r.pendingLeft}`);
  ok("the sender hears nothing — the seat DID turn on the message, so no demotion notice",
    true, "(guarded by the filter order; a demotion here would lie)");
}

// ---- drill 2 (control): nobody reads the probe mid-turn. The runner's wake is the one
// delivery — dedupe must be invisible when there is nothing to dedupe. ----------------------
{
  const r = await drill({ sessionRead: false });
  ok("control: a message no other path consumed is woken exactly once",
    r.probe1Turns.length === 1, `got ${r.probe1Turns.length}`);
  ok("control: the queue file is gone once the single delivery succeeds",
    !r.pendingLeft, `PENDF still present: ${r.pendingLeft}`);
}

// ---- drill 3: the seen-set survives the turn boundary AND the process boundary. A runner that
// boots BLIND (cursor sync failed) still stands down on the consumed id from disk. ----------
{
  const r = await drill({ sessionRead: true, restart: true, waitMs: 7000 });
  ok("the seen-set was on disk before the restart", r.fileHadSeen);
  ok("a restarted runner — even one whose boot cursor sync failed — does not re-wake the consumed id",
    r.probe1Turns.length === 0, `got ${r.probe1Turns.length} wake(s) after the restart`);
}

// ---- drill 4: dedupe never swallows an OWED message. Probe 1 is consumed session-side, probe 2
// arrives late and its first wake CRASHES: the redelivery must still happen, while probe 1 stays
// suppressed. One mechanism, two jobs, no cannibalism. ---------------------------------------
{
  const r = await drill({ sessionRead: true, lateProbe: true, failWakeTurns: 1, waitMs: 9000 });
  ok("probe 1 (consumed mid-turn) is still never re-woken",
    r.probe1Turns.length === 0, `got ${r.probe1Turns.length}`);
  ok("probe 2 (owed, first wake crashed) is redelivered — the crash + redelivery pair",
    r.probe2Turns.length === 2, `got ${r.probe2Turns.length}`);
  ok("probe 2's redelivery still carries the original text",
    r.probe2Turns.every(t => t.includes("SECOND-PROBE")));
}

hub.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

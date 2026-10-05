// #9832 part 4: the wake-policy suite grew to 150s under one roof and hit the runner's per-suite
// cap, so the suite is split by feature into three files (test-wake-policy, test-wake-card-binding,
// test-wake-demotions-threading). This is their ONE mock hub + runner harness, moved verbatim from
// the original file: the hub hands out one batch of messages (or a SEQUENCE of batches for the
// #7288 threading drills), then stays silent — whatever the seat does with them is the test. The
// mock BOARD (/card /tasks) holds what the runner's #7763 board checks read.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { drillEnv } from "../drill-env.mjs";

const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

export async function createWakeHarness() {
  let queued = [], served = 0, links = [], sent = [], batchQueue = [], msgSeq = 1;
  let cardStore = {}, tasksList = [];
  const hub = http.createServer((req, res) => {
    let buf = ""; req.on("data", c => (buf += c));
    req.on("end", () => {
      const u = new URL(req.url, "http://x"), P = u.pathname;
      const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (P === "/inbox") return reply({ messages: [], cursor: 0 });
      if (P === "/lessons") return reply({ lessons: [] });
      if (P === "/policy") return reply({ links, autonomy: { "*": 1 } });
      if (P === "/send") { try { sent.push(JSON.parse(buf || "{}")); } catch {} return reply({ ok: true, id: sent.length }); }
      if (P === "/card") { const id = Number(u.searchParams.get("id")); return reply({ task: cardStore[id] || null, events: [], messages: [] }); }
      if (P === "/tasks") return reply({ tasks: tasksList });
      if (P === "/poll") {
        if (batchQueue.length) {
          const batch = batchQueue.shift().map((m, i) => {
            const out = { id: msgSeq++, ts: Date.now(), to: u.searchParams.get("session"), from: "sasha@mac", ...m };
            if (out.re === "@receipt") {   // thread onto the receipt the runner last SENT (#7288)
              const at = sent.map(s => s.kind).lastIndexOf("receipt");
              if (at >= 0) out.re = at + 1;   // /send answers { id: sent.length }
            }
            return out;
          });
          return reply({ messages: batch, cursor: msgSeq });
        }
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
  async function spawnDrill({ waitMs = 7000, projectLinks = [] } = {}) {
    const work = mkdtempSync(join(tmpdir(), "tt-wake-"));
    const HOME = join(work, "home");
    mkdirSync(join(HOME, ".agent-bus"), { recursive: true });
    const fakebin = join(work, "bin"); mkdirSync(fakebin, { recursive: true });
    const LOGF = join(work, "turns.log");
    const PROJ = "tt-wake";
    writeFileSync(join(fakebin, "codex"), `#!/bin/sh
P="$HOME/.agent-bus/turn-codex-${PROJ}.txt"
{ echo "===TURN=== mode=$1 sub=$2"; cat "$P"; } >> "${LOGF}"
# #7759: the success answer must clear the substantive floor, or every turn reads as an
# EMPTY hollow turn and its wake is never consumed — this drill tests wake policy, not validity.
echo "the contract is worked: the card moved with a note, the files changed, and the"
echo "assigner has been told the outcome, so this turn is done and consumed its wake."
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
      // `codex exec resume --last` carries "resume" as the SECOND argv word; a fresh `codex exec`
      // has none. (#6289 regression: mode=$1 alone read "exec" for BOTH shapes, so these fresh/
      // resumed counts were vacuous and the resume downgrade slipped past them.)
      fresh: turns.filter(t => t.includes("NEW BUS MESSAGE") && !/^ mode=\S+ sub=resume\b/.test(t)),
      resumed: turns.filter(t => t.includes("NEW BUS MESSAGE") && /^ mode=\S+ sub=resume\b/.test(t)),
      sent,
    };
  }
  async function drill(messages, { waitMs = 7000, projectLinks = [], cards, tasks } = {}) {
    queued = messages; served = 0; links = projectLinks; sent = []; batchQueue = [];
    // #7763: the mock BOARD for this drill — the cards whose ids the wake cites, and what the seat owns.
    cardStore = cards || {}; tasksList = tasks || [];
    return spawnDrill({ waitMs, projectLinks });
  }
  // #7288: several batches handed out one per poll, so a message can REPLY to something the seat
  // said in an earlier batch (re:"@receipt" resolves to the receipt the runner last sent).
  async function drillSequence(batches, { waitMs = 7000, projectLinks = [] } = {}) {
    batchQueue = batches; queued = []; served = 0; links = projectLinks; sent = []; msgSeq = 1; cardStore = {}; tasksList = [];
    return spawnDrill({ waitMs, projectLinks });
  }
  // #7060's armed-seat leg spawns its own runner (claude CLI, stdout capture) — it pokes the
  // handout state directly instead of going through drill().
  function setMock({ queued: q, served: s, links: l, sent: se } = {}) {
    if (q !== undefined) queued = q;
    if (s !== undefined) served = s;
    if (l !== undefined) links = l;
    if (se !== undefined) sent = se;
  }
  return { hub, HUB, drill, drillSequence, setMock, close: () => hub.close() };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

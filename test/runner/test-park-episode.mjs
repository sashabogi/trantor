#!/usr/bin/env node
// trantor park-episode drill (#13949) — a parked seat re-sent the same "PARKED (no-delivery)" DM
// every redelivery window for hours: one park episode, ten identical messages. The episode is the
// event boundary: one notice when the park starts, one when it ends, retries inside send NOTHING.
// Drives the REAL runner with a fake `codex` that no-delivers four times, ships the fifth.
import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { drillEnv } from "../drill-env.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

console.log("# trantor park-episode drill (#13949)");

// ---- mock hub: one direct contract bound to card #13949, a card store, and a /card read --------
const CARD = 13949;
const sends = [];
let handed = 0;
const cards = new Map([[CARD, { id: CARD, status: "todo" }]]);
const MSG = { id: 7, from: "owner@laptop", text: `contract: work card #${CARD} — fix the park spam and gate output`, ts: Date.now() };
const hub = http.createServer((req, res) => {
  let buf = ""; req.on("data", c => (buf += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x"), P = u.pathname;
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "POST" && P === "/send") {
      try { sends.push(JSON.parse(buf)); } catch {}
      return reply({ ok: true, id: sends.length });
    }
    if (req.method === "POST" && P === "/card-move") {
      try {
        const body = JSON.parse(buf);
        const t = cards.get(Number(body.id));
        if (t) t.status = String(body.status || "todo");
      } catch {}
      return reply({ ok: true });
    }
    if (P === "/card") return reply({ ok: true, task: cards.get(Number(u.searchParams.get("id") || 0)) || null });
    if (P === "/events") return reply({ events: [], cursor: 0, latest: 0 });
    if (P === "/inbox") return reply({ messages: [], cursor: 0 });
    if (P === "/lessons") return reply({ lessons: [] });
    if (P === "/policy") return reply({ links: [], autonomy: { "*": 1 } });
    if (P === "/poll") {
      if (handed === 0) { handed = 1; return reply({ messages: [{ ...MSG, to: u.searchParams.get("session") }], cursor: 1 }); }
      return setTimeout(() => reply({ messages: [], cursor: 1 }), 250);
    }
    return reply({ ok: true });
  });
});
await new Promise(r => hub.listen(0, "127.0.0.1", r));
const HUB = `http://127.0.0.1:${hub.address().port}`;

// ---- harness: the REAL runner + a fake `codex`. Wake turns 1-4: exit 0, prose, touches NOTHING
// (the no-delivery shape — the card is bound and never moves). Wake turn 5: ships the commit, so
// the park's last window-lift retry finally delivers and the episode ends.
const PROJ = "tt-park-ep";
const root = mkdtempSync(join(tmpdir(), "tt-park-ep-"));
const HOME = join(root, "home");
const REPO = join(root, "repo");
const BUS = join(HOME, ".agent-bus");
mkdirSync(BUS, { recursive: true });
mkdirSync(REPO, { recursive: true });
execSync("git init -q -b main", { cwd: REPO });
writeFileSync(join(REPO, "seed.txt"), "seed\n");
execSync("git add -A", { cwd: REPO });
execSync("git -c user.name=d -c user.email=d@d commit -qm init", { cwd: REPO });
const fakebin = join(root, "bin"); mkdirSync(fakebin, { recursive: true });
const LOGF = join(root, "turns.log"), CNTF = join(root, "count");
writeFileSync(join(fakebin, "codex"), `#!/bin/sh
P="$HOME/.agent-bus/turn-codex-${PROJ}.txt"
{ echo "===TURN==="; cat "$P"; } >> "${LOGF}"
if grep -q "NEW BUS MESSAGE" "$P"; then
  n=$(cat "${CNTF}" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${CNTF}"
  if [ "$n" -ge 5 ]; then
    echo "shipped $n" > "shipped-$n.txt"
    git add -A && git -c user.name=d -c user.email=d@d commit -qm "w$n"
  fi
fi
echo "OpenAI Codex v2.3.4"
echo "--------"
echo "workdir: $PWD"
echo "model: drill-1"
echo "session: tt-1234"
echo "tokens used: 1,337"
echo "the gate ran green on the committed work and the card can move; this turn did what the"
echo "contract asked and the ledger can close it."
exit 0
`);
chmodSync(join(fakebin, "codex"), 0o755);
const PENDF = join(BUS, `pending-codex-${PROJ}.json`);
const runner = spawn("node", ["bin/crew-runner.mjs", "codex", REPO], {
  cwd: process.cwd(), stdio: "ignore",
  env: {
    ...drillEnv({ TRANTOR_NO_DESKTOP_NOTIFY: "1" }), HOME, PATH: `${fakebin}:${process.env.PATH}`,
    RELAY_URL: HUB, RELAY_AGENT: "codex", RELAY_PROJECT: PROJ,
    CREW_KICKOFF: "say hi and end your turn",
    // a short ladder to the first park, and a park window short enough that several redelivery
    // cycles fit in the drill: attempt, attempt, park, then window-lift retries that re-park.
    TRANTOR_RETRY_MS: "600",
    TRANTOR_PARK_WINDOW_MS: "3000",
  },
});
await sleep(26000);
runner.kill("SIGKILL"); await sleep(200);
const turns = read(LOGF).split("===TURN===").filter(t => t.trim());
const wakeTurns = turns.filter(t => t.includes("NEW BUS MESSAGE"));

// ---- the episode, as the bus saw it ------------------------------------------------------------
const parked = sends.filter(s => /PARKED/.test(s.text || ""));
const recovered = sends.filter(s => /recovered/.test(s.text || ""));
const toAssigner = (list) => list.filter(s => s.to === "owner@laptop");
const toRoom = (list) => list.filter(s => s.to === "all");
const toOrch = (list) => list.filter(s => s.to && s.to !== "all" && s.to !== "owner@laptop");

console.log("\n## the seat parked and rode several redelivery cycles");
ok("#13949: the contract was attempted twice, then re-attempted across park windows until it delivered — 5 wake turns",
  wakeTurns.length === 5, `got ${wakeTurns.length} wake turn(s)`);
ok("#13949: the seat PARKED (the notices exist)", parked.length > 0,
  `${sends.length} send(s): ${sends.map(s => `${s.to}: ${String(s.text).slice(0, 60)}`).join(" | ")}`);
ok("#13949: the fifth attempt delivered — the queue is cleared and the assigner heard done",
  !existsSync(PENDF) && sends.some(s => s.to === "owner@laptop" && /✅ done on/.test(s.text || "")));

console.log("\n## one notice when the park starts, one when it ends, nothing between");
ok("#13949: the assigner hears PARKED once — not one DM per redelivery cycle (the incident's 10)",
  toAssigner(parked).length === 1, `${toAssigner(parked).length} park DM(s) to owner@laptop: ${toAssigner(parked).map(s => String(s.text).slice(0, 90)).join(" | ")}`);
ok("#13949: the room broadcast and the orchestrator alert each fired once at the episode start",
  toRoom(parked).length === 1 && toOrch(parked).length === 1,
  `room ${toRoom(parked).length}, orch ${toOrch(parked).length}`);
ok("#13949: the park notice says WHEN the park lifts",
  toAssigner(parked).length === 1 && /resumes |not retrying/.test(toAssigner(parked)[0].text || ""),
  toAssigner(parked)[0] && String(toAssigner(parked)[0].text));
const orchEpisode = toOrch([...parked, ...recovered]);
const orchOrder = orchEpisode.map(s => (/PARKED/.test(s.text || "") ? "parked" : "recovered")).join(",");
ok("#13949: the orchestrator gets exactly two messages for the whole episode — parked, then recovered",
  orchEpisode.length === 2 && orchOrder === "parked,recovered",
  `${orchEpisode.length} message(s), order ${orchOrder}`);
// "nothing in between" on the stream the orchestrator actually reads: every direct send to it
// between the park notice and the recovery. On the old code the re-parks re-sent the DM here.
const orchSends = sends.filter(s => s.to && s.to !== "all" && s.to !== "owner@laptop");
const parkAt = orchSends.findIndex(s => /PARKED/.test(s.text || ""));
const recAt = orchSends.findIndex(s => /recovered/.test(s.text || ""));
ok("#13949: nothing rides between them — the window-lift retries that re-parked sent NOTHING",
  parkAt > -1 && recAt > parkAt && orchSends.slice(parkAt + 1, recAt).length === 0,
  JSON.stringify(orchSends.slice(parkAt + 1, recAt).map(s => String(s.text).slice(0, 70))));
ok("#13949: the recovery names the reason and how long the park lasted",
  toOrch(recovered).length === 1 && /recovered — no-delivery park over after \d+[sm] /.test(toOrch(recovered)[0].text || ""),
  toOrch(recovered)[0] && String(toOrch(recovered)[0].text));
ok("#13949: the room hears the recovery once too", toRoom(recovered).length === 1,
  `${toRoom(recovered).length} recovered broadcast(s)`);
ok("#13949: the ladder's own recovery echo is suppressed — exactly one recovered per recipient",
  recovered.length === 2, `${recovered.length} recovered send(s) total`);

hub.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

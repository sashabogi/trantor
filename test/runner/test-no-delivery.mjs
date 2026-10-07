#!/usr/bin/env node
// #10197 no-delivery drill — a card-bound turn reads done only on delivery: a NEW commit since
// turn start, or the card moved to testing/done. The ibkr specimen (48s, exit 0, prose output, no
// commit, card still todo) is NO-DELIVERY and the contract stays owed; a committed turn and a
// moved card still read done; a failed hub read keeps today's label. Hermetic.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { drillEnv } from "../drill-env.mjs";
import { noDeliveryVerdict } from "../../lib/classify-failure.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

console.log("# trantor no-delivery drill (#10197)");

// ---- unit: the verdict string ------------------------------------------------------------------
{
  ok("#10197: noDeliveryVerdict names the card, the gap and the status",
    noDeliveryVerdict(10491, "todo") === "classified no-delivery because exit 0 with no new commit and card #10491 still todo",
    noDeliveryVerdict(10491, "todo"));
}

// ---- mock hub: one direct contract bound to card #10491, a card store, and a /card read --------
const CARD = 10491;
const sends = [];
let eventSeq = 0;
let handed = 0;
let cardFail = false;
let followup = false;
const cards = new Map([[CARD, { id: CARD, status: "todo" }]]);
const MSG = { id: 7, from: "sasha@mac", to: "", text: `contract: work card #${CARD} — run the tests and gate output`, ts: Date.now() };
const hub = http.createServer((req, res) => {
  let buf = ""; req.on("data", c => (buf += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x"), P = u.pathname;
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "POST" && P === "/send") {
      try { sends.push(JSON.parse(buf)); eventSeq++; } catch {}
      return reply({ ok: true, id: sends.length });
    }
    if (req.method === "POST" && P === "/card-move") {
      try {
        const body = JSON.parse(buf);
        const t = cards.get(Number(body.id));
        if (t) t.status = String(body.status || "todo");
        eventSeq++;
      } catch {}
      return reply({ ok: true });
    }
    if (P === "/card") {
      if (cardFail) { res.writeHead(500, { "content-type": "text/plain" }); return res.end("nope"); }
      const id = Number(u.searchParams.get("id") || 0);
      const t = cards.get(id);
      return reply({ ok: true, task: t ? { ...t } : null });
    }
    if (P === "/events") {
      const since = Number(u.searchParams.get("since") || 0);
      return reply({ events: eventSeq > since ? [{ id: eventSeq, ts: Date.now(), type: "message", project: "", by: "sasha@mac" }] : [], cursor: eventSeq, latest: eventSeq });
    }
    if (P === "/contracts") return reply({ contracts: [] });
    if (P === "/inbox") return reply({ messages: [], cursor: 0 });
    if (P === "/lessons") return reply({ lessons: [] });
    if (P === "/policy") return reply({ links: [], autonomy: { "*": 1 } });
    if (P === "/poll") {
      if (handed === 0) { handed = 1; return reply({ messages: [{ ...MSG, to: u.searchParams.get("session") }], cursor: 1 }); }
      if (followup && handed === 1 && sends.some(s => /⚠ no commit, card/.test(s.text || ""))) {
        handed++;
        return reply({ messages: [{ ...MSG, id: 8, to: u.searchParams.get("session"),
          text: `card #${CARD}: second contract — commit the fix now` }], cursor: 8 });
      }
      return setTimeout(() => reply({ messages: [], cursor: 1 }), 250);
    }
    return reply({ ok: true });
  });
});
await new Promise(r => hub.listen(0, "127.0.0.1", r));
const HUB = `http://127.0.0.1:${hub.address().port}`;

// ---- harness: the REAL runner + a fake `codex` ----------------------------------------------
// ibkr: exit 0, substantive prose, touches NOTHING — the 48s specimen. commit: ships a real git
// commit in its cwd. movetesting: moves card #10491 to testing on the hub mid-turn. The repo
// starts at an initial commit so headBefore resolves and a commit is a HEAD move.
async function drill(mode, { waitMs = 12000, failCard = false } = {}) {
  sends.length = 0; eventSeq = 0; handed = 0; cardFail = failCard;
  followup = mode === "followup";
  cards.set(CARD, { id: CARD, status: "todo" });
  const root = mkdtempSync(join(tmpdir(), "tt-nodelivery-"));
  const HOME = join(root, "home");
  const REPO = join(root, "repo");
  const BUS = join(HOME, ".agent-bus");
  mkdirSync(BUS, { recursive: true });
  mkdirSync(REPO, { recursive: true });
  const g = (args) => execSync(`git ${args}`, { cwd: REPO, stdio: "ignore" });
  g("init -q -b main");
  writeFileSync(join(REPO, "seed.txt"), "seed\n");
  g("add -A");
  g("-c user.name=d -c user.email=d@d commit -qm init");
  const fakebin = join(root, "bin"); mkdirSync(fakebin, { recursive: true });
  const LOGF = join(root, "turns.log"), CNTF = join(root, "count");
  const PROJ = "tt-nodelivery";
  writeFileSync(join(fakebin, "codex"), `#!/bin/sh
P="$HOME/.agent-bus/turn-codex-${PROJ}.txt"
{ echo "===TURN==="; cat "$P"; } >> "${LOGF}"
if grep -q "NEW BUS MESSAGE" "$P"; then
  n=$(cat "${CNTF}" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${CNTF}"
  if [ "${mode}" = "commit" ] || { [ "${mode}" = "followup" ] && [ "$n" -gt 1 ]; }; then
    echo "shipped $n" > "shipped-$n.txt"
    git add -A && git -c user.name=d -c user.email=d@d commit -qm "w$n"
  fi
  if [ "${mode}" = "movetesting" ]; then
    node --input-type=module -e "await fetch(process.env.RELAY_URL + '/card-move', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: '${PROJ}', id: ${CARD}, status: 'testing' }) })" || true
  fi
  echo "The gate passed on eab5766: 92 wake-policy assertions green, slop-gate clean, and the"
  echo "worktree holds only the two committed files. Nothing else moved during the turn, so"
  echo "the contract is satisfied and the card can move to testing with the counts attached."
fi
echo "OpenAI Codex v2.3.4"
echo "--------"
echo "workdir: $PWD"
echo "model: drill-1"
echo "session: tt-1234"
echo "tokens used: 1,337"
exit 0
`);
  chmodSync(join(fakebin, "codex"), 0o755);
  const PENDF = join(BUS, `pending-codex-${PROJ}.json`);
  const JSONL = join(BUS, "logs", `codex-${PROJ}.jsonl`);
  const runner = spawn("node", ["bin/crew-runner.mjs", "codex", REPO], {
    cwd: process.cwd(), stdio: "ignore",
    env: { ...drillEnv({ TRANTOR_NO_DESKTOP_NOTIFY: "1" }), HOME, PATH: `${fakebin}:${process.env.PATH}`,
      RELAY_URL: HUB, RELAY_AGENT: "codex", RELAY_PROJECT: PROJ,
      TRANTOR_RETRY_MS: followup ? "60000" : "1200", CREW_KICKOFF: "say hi and end your turn" },
  });
  await sleep(waitMs);
  runner.kill("SIGKILL"); await sleep(150);
  const turns = read(LOGF).split("===TURN===").filter(t => t.trim());
  const rows = read(JSONL).split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } });
  return {
    turns, wakeTurns: turns.filter(t => t.includes("NEW BUS MESSAGE")), rows, handed,
    sends: [...sends], pendingLeft: existsSync(PENDF),
    card: cards.get(CARD),
  };
}

// ---- drill 1: the ibkr shape — exit 0, output, no commit, card still todo -> NO-DELIVERY -------
console.log("\n## the ibkr shape is no-delivery");
{
  const r = await drill("ibkr");
  ok("#10197: the no-delivery contract is attempted exactly twice, then parked — no third attempt",
    r.wakeTurns.length === 2, `got ${r.wakeTurns.length} wake turn(s)`);
  ok("#10197: the hub handed the message out ONCE — the second attempt is the runner's own queue",
    r.handed === 1, `handed ${r.handed}`);
  const warns = r.sends.filter(s => s.to === "sasha@mac" && /⚠ no commit, card #10491 still todo/.test(s.text || ""));
  ok("#10197: the assigner hears '⚠ no commit, card #10491 still todo', once",
    warns.length === 1, `${warns.length} notice(s): ${warns.map(s => String(s.text).slice(0, 120)).join(" | ")}`);
  ok("#10197: no done receipt went out for a no-delivery turn",
    !r.sends.some(s => s.to === "sasha@mac" && /✅ done on/.test(s.text || "")));
  ok("#10197: the wake is NOT consumed — the queue file survives the park", r.pendingLeft);
  const parks = r.sends.filter(s => s.to === "all" && /PARKED/.test(s.text || ""));
  ok("#10197: the second no-delivery attempt PARKS the seat, naming no-delivery",
    parks.length === 1 && /no-delivery/.test(parks[0].text || ""),
    parks[0] && String(parks[0].text).slice(0, 140));
  const row = r.rows.find(x => x.trigger === "direct message");
  ok("#10197: the telemetry row binds the contract's card",
    row && row.card === CARD, JSON.stringify(row && { card: row.card }));
  ok("#10197: the ledger row reads outcome no-delivery",
    row && row.outcome === "no-delivery", JSON.stringify(row && { outcome: row.outcome, verdict: row.verdict }));
  ok("#10197: the verdict names the gap — no new commit, card still todo",
    row && /no-delivery/.test(row.verdict || "") && /still todo/.test(row.verdict || ""),
    row && row.verdict);
}

console.log("\n## a second contract on the same card wakes before the no-delivery retry");
{
  const r = await drill("followup");
  const wakes = r.rows.filter(x => x.trigger === "direct message");
  ok("#10197: both same-card contracts get a turn before the 60s retry", r.handed === 2 && r.wakeTurns.length === 2);
  ok("#10197: first contract records no-delivery and second delivers",
    wakes.length === 2 && wakes[0].outcome === "no-delivery" && wakes[1].outcome === "completed"
    && wakes.every(x => x.card === CARD));
  ok("#10197: the second turn sees both the owed contract and the new instruction",
    r.wakeTurns[1]?.includes(MSG.text) && r.wakeTurns[1]?.includes("second contract — commit the fix now"));
  ok("#10197: follow-up delivery clears the owed queue", !r.pendingLeft);
  ok("#10197: no no-delivery park suppresses the follow-up", !r.sends.some(s => /PARKED/.test(s.text || "")));
}

// ---- drill 2: a committed turn reads done ------------------------------------------------------
console.log("\n## a new commit is delivery");
{
  const r = await drill("commit");
  ok("#10197: a turn that ships a commit completes and consumes the wake",
    r.wakeTurns.length === 1, `got ${r.wakeTurns.length} wake turn(s)`);
  ok("#10197: the assigner hears done", r.sends.some(s => s.to === "sasha@mac" && /✅ done on/.test(s.text || "")));
  ok("#10197: no no-delivery notice for a committing turn",
    !r.sends.some(s => /no commit, card/.test(s.text || "")));
  ok("#10197: the queue is cleared once the turn delivered", !r.pendingLeft);
  const row = r.rows.find(x => x.trigger === "direct message");
  ok("#10197: telemetry outcome completed", row && row.outcome === "completed", JSON.stringify(row && { outcome: row.outcome }));
}

// ---- drill 3: a card moved to testing reads done -----------------------------------------------
console.log("\n## a card move is delivery");
{
  const r = await drill("movetesting");
  ok("#10197: the fake moved the card to testing", r.card && r.card.status === "testing", r.card && r.card.status);
  ok("#10197: a turn that moves its card to testing completes and consumes the wake",
    r.wakeTurns.length === 1, `got ${r.wakeTurns.length} wake turn(s)`);
  ok("#10197: the assigner hears done, not no-delivery",
    r.sends.some(s => s.to === "sasha@mac" && /✅ done on/.test(s.text || ""))
    && !r.sends.some(s => /no commit, card/.test(s.text || "")));
  ok("#10197: the queue is cleared", !r.pendingLeft);
  const row = r.rows.find(x => x.trigger === "direct message");
  ok("#10197: telemetry outcome completed", row && row.outcome === "completed", JSON.stringify(row && { outcome: row.outcome }));
}

// ---- drill 4: a failed hub read keeps today's label --------------------------------------------
console.log("\n## a failed hub read stands down");
{
  const r = await drill("ibkr", { failCard: true });
  ok("#10197: with /card failing the turn still reads done — never no-delivery on a dead read",
    r.wakeTurns.length === 1 && r.sends.some(s => s.to === "sasha@mac" && /✅ done on/.test(s.text || "")),
    `wakeTurns ${r.wakeTurns.length}`);
  ok("#10197: no no-delivery notice went out on a dead read",
    !r.sends.some(s => /no commit, card/.test(s.text || "")));
  ok("#10197: the queue is cleared (today's label = done)", !r.pendingLeft);
  const row = r.rows.find(x => x.trigger === "direct message");
  ok("#10197: telemetry outcome completed, not no-delivery",
    row && row.outcome === "completed", JSON.stringify(row && { outcome: row.outcome, verdict: row.verdict }));
}

hub.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// #10824 stale-card-binding drill — the ledger row names the card of the CONTRACT BEING SERVED,
// never one quoted from a contract still queued behind it or inherited from the previous turn.
// The ibkr shape: contract A (#X) no-delivered and stayed owed, contract B naming only #Y arrived,
// and the next turn's row said #X — so #10197's no-delivery judge read the WRONG card's status.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { drillEnv } from "../drill-env.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

console.log("# trantor stale-card-binding drill (#10824)");

// ---- mock hub: contract A for #10800, then contract B citing only #10810 -----------------------
const CARD_A = 10800;
const CARD_B = 10810;
const sends = [];
let eventSeq = 0;
let handed = 0;
const cards = new Map([
  [CARD_A, { id: CARD_A, status: "todo" }],
  [CARD_B, { id: CARD_B, status: "todo" }],
]);
const MSG_A = { id: 11, from: "sasha@mac", text: `contract: work card #${CARD_A} — run the tests and gate output`, ts: Date.now() };
// B names only #Y: a bare citation, no assignment shape, no mention of A's card at all — exactly
// the shape whose binding the old scan lost to A's "contract: card #X" sitting queued behind it.
const MSG_B = { id: 12, from: "sasha@mac", text: `#${CARD_B} is the one to work now — the earlier contract stays owed until this lands`, ts: Date.now() };
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
      const to = u.searchParams.get("session");
      if (handed === 0) { handed = 1; return reply({ messages: [{ ...MSG_A, to }], cursor: 1 }); }
      if (handed === 1) { handed = 2; return reply({ messages: [{ ...MSG_B, to }], cursor: 1 }); }
      return setTimeout(() => reply({ messages: [], cursor: 1 }), 250);
    }
    return reply({ ok: true });
  });
});
await new Promise(r => hub.listen(0, "127.0.0.1", r));
const HUB = `http://127.0.0.1:${hub.address().port}`;

// ---- harness: the REAL runner + a fake `codex` that exits 0 and delivers NOTHING ---------------
// The ibkr specimen on purpose: exit 0, prose, no commit, cards never move — so contract A stays
// owed and rides in the queue when B is served, which is the batch the stale binding came from.
async function drill({ waitMs = 14000 } = {}) {
  sends.length = 0; eventSeq = 0; handed = 0;
  cards.set(CARD_A, { id: CARD_A, status: "todo" });
  cards.set(CARD_B, { id: CARD_B, status: "todo" });
  const root = mkdtempSync(join(tmpdir(), "tt-stalebind-"));
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
  const LOGF = join(root, "turns.log");
  const PROJ = "tt-stalebind";
  writeFileSync(join(fakebin, "codex"), `#!/bin/sh
P="$HOME/.agent-bus/turn-codex-${PROJ}.txt"
{ echo "===TURN==="; cat "$P"; } >> "${LOGF}"
echo "OpenAI Codex v2.3.4"
echo "--------"
echo "workdir: $PWD"
echo "model: drill-1"
echo "session: tt-1234"
echo "The contract was read and the state checked; the worktree holds only the seed"
echo "commit and nothing was shipped or moved during this turn."
echo "tokens used: 1,337"
exit 0
`);
  chmodSync(join(fakebin, "codex"), 0o755);
  const PENDF = join(BUS, `pending-codex-${PROJ}.json`);
  const JSONL = join(BUS, "logs", `codex-${PROJ}.jsonl`);
  const TURNSTATE = join(BUS, "turnstate-codex-" + PROJ + ".json");
  const runner = spawn("node", ["bin/crew-runner.mjs", "codex", REPO], {
    cwd: process.cwd(), stdio: "ignore",
    env: { ...drillEnv({ TRANTOR_NO_DESKTOP_NOTIFY: "1" }), HOME, PATH: `${fakebin}:${process.env.PATH}`,
      RELAY_URL: HUB, RELAY_AGENT: "codex", RELAY_PROJECT: PROJ,
      TRANTOR_RETRY_MS: "1200", CREW_KICKOFF: "say hi and end your turn" },
  });
  await sleep(waitMs);
  runner.kill("SIGKILL"); await sleep(150);
  const turns = read(LOGF).split("===TURN===").filter(t => t.trim());
  const rows = read(JSONL).split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } });
  let state = {};
  try { state = JSON.parse(read(TURNSTATE)); } catch {}
  return {
    turns, wakeTurns: turns.filter(t => t.includes("NEW BUS MESSAGE")), rows, handed, state,
    sends: [...sends], pendingLeft: existsSync(PENDF),
  };
}

console.log("\n## contract A #X is served, stays owed, then B naming only #Y is served");
{
  const r = await drill({ waitMs: 14000 });
  ok("#10824: both contracts got their turn — A served, then the batch with B",
    r.wakeTurns.length === 2, `got ${r.wakeTurns.length} wake turn(s); hub handed ${r.handed}`);
  const rows = r.rows.filter(x => x.trigger === "direct message" || /redelivery/.test(x.trigger || ""));
  ok("#10824: turn A's row binds #X",
    rows[0] && rows[0].card === CARD_A, JSON.stringify(rows[0] && { trigger: rows[0].trigger, card: rows[0].card }));
  ok("#10824: turn B's row binds #Y — never #X quoted from the contract queued behind it",
    rows[1] && rows[1].card === CARD_B, JSON.stringify(rows[1] && { trigger: rows[1].trigger, card: rows[1].card }));
  ok("#10824: B's turn opens a FRESH session for #Y (the binding moved, the seat is told)",
    r.wakeTurns[1]?.includes(`FRESH SESSION for card #${CARD_B}`), r.wakeTurns[1]?.slice(0, 400));
  ok("#10824: B's turn is never told it is A's card",
    r.wakeTurns[1] && !r.wakeTurns[1].includes(`FRESH SESSION for card #${CARD_A}`)
      && !r.wakeTurns[1].includes(`relay_board with card:${CARD_A}`), r.wakeTurns[1]?.slice(0, 400));
  // The ladder warns ONCE (attempt 1, served contract A — so #A is CORRECT there) and parks on
  // attempt 2; the park is where a stale label would lie about the served contract.
  const warns = r.sends.filter(s => s.to === "sasha@mac" && s.text?.startsWith("⚠ no commit"));
  ok("#10824: the single no-delivery warning belongs to A's turn and names #A",
    warns.length === 1 && warns[0].text.includes(`card #${CARD_A} still todo`),
    warns.map(s => String(s.text).slice(0, 110)).join(" | "));
  const parks = r.sends.filter(s => s.to === "sasha@mac" && /PARKED/.test(s.text || ""));
  ok("#10824: the park notice names #Y — the second no-delivery turn read the SERVED card",
    parks.length === 1 && new RegExp(`card #${CARD_B} unmoved`).test(parks[0].text || ""),
    parks[0] && String(parks[0].text).slice(0, 160));
  ok("#10824: the turnstate file (what seat-why reads) says #Y after the run",
    r.state && r.state.card === CARD_B, JSON.stringify(r.state && { card: r.state.card, phase: r.state.phase }));
  ok("#10824: the queue stays owed after two no-delivery attempts", r.pendingLeft);
}

hub.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

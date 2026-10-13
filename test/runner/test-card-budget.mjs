#!/usr/bin/env node
// #11559 drills - the seat fleet's runaway context: (1) the OPENCODE_CONFIG_CONTENT compaction block
// builder (default, off, custom, invalid); (2) the per-provider token report against a
// FIXTURE sqlite DB (never the operator's real one); (3) end-to-end: a card crossing
// TRANTOR_CARD_TOKEN_BUDGET alerts once, its further contracts buy no CLI turn, another card runs.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { drillEnv } from "../drill-env.mjs";
import { ocCompactionContent } from "../../lib/seat-compaction.mjs";
import { seatTokensReport, providerOf } from "../../lib/seat-tokens.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
// Scratch under the repo's gitignored .agent-bus-out, not the shared tmpdir: a FAIL leaves the
// runner log and fixture world inspectable instead of auto-cleaned.
const SCRATCH = join(process.cwd(), ".agent-bus-out", "11559-fixtures");
mkdirSync(SCRATCH, { recursive: true });

console.log("# trantor card-budget + compaction drills (#11559)");

// ---- unit: the compaction content builder ------------------------------------------------------
{
  const d = JSON.parse(ocCompactionContent({}));
  ok("#11559: default arms the opencode compaction block", d.compaction && d.compaction.auto === true
    && d.compaction.prune === true && d.compaction.tail_turns === 4 && d.compaction.reserved === 64000
    && d.compaction.preserve_recent_tokens === 24000, ocCompactionContent({}));
  ok("#11559: TRANTOR_OC_COMPACTION=off injects nothing", ocCompactionContent({ TRANTOR_OC_COMPACTION: "off" }) === "");
  const c = JSON.parse(ocCompactionContent({ TRANTOR_OC_COMPACTION: '{"auto":true,"reserved":900000}' }));
  ok("#11559: custom JSON wraps as { compaction }", c.compaction && c.compaction.reserved === 900000 && c.compaction.auto === true);
  ok("#11559: invalid JSON injects nothing", ocCompactionContent({ TRANTOR_OC_COMPACTION: "{nope" }) === "");
  ok("#11559: a non-object JSON injects nothing", ocCompactionContent({ TRANTOR_OC_COMPACTION: "[1,2]" }) === "");
}

// ---- unit: providerOf + the token report on a fixture DB ----------------------------------------
{
  ok("#11559: providerOf splits provider/model", providerOf("qwen/qwen3.8-flash") === "qwen" && providerOf("glm-5.1") === "?" && providerOf("") === "?");
  ok("#11559: providerOf reads the 1.16.x JSON blob model ids",
    providerOf('{"id":"glm-5.3-flash","providerID":"zai-coding-plan","variant":"high"}') === "zai-coding-plan"
    && providerOf('{"id":"deepseek-v4-pro","providerID":"qwen"}') === "qwen"
    && providerOf('{"id":"x"}') === "?", providerOf('{"id":"glm-5.3-flash","providerID":"zai-coding-plan"}'));
  const root = mkdtempSync(join(SCRATCH, "tt-seat-tokens-"));
  const db = join(root, "oc.db");
  const now = Date.now();
  writeFileSync(join(root, "init.sql"), `
CREATE TABLE session (id TEXT PRIMARY KEY, model TEXT, tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0,
  tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0, cost REAL DEFAULT 0,
  time_created INTEGER, time_updated INTEGER);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
INSERT INTO session VALUES ('ses_a','qwen/qwen3.8-flash', 100, 10, 900, 5, 1.5, ${now - 5000}, ${now - 1000});
INSERT INTO session VALUES ('ses_b','qwen/qwen3.8-max', 200, 20, 800, 5, 2.5, ${now - 4000}, ${now - 2000});
INSERT INTO session VALUES ('ses_j','{"id":"glm-5.3-flash","providerID":"zai-coding-plan","variant":"high"}', 10, 1, 20, 0, 0, ${now - 3000}, ${now - 3000});
INSERT INTO session VALUES ('ses_c','deepseek/deepseek-v4', 50, 5, 45, 0, 0.1, ${now - 90 * 86400000}, ${now - 90 * 86400000});
INSERT INTO message VALUES ('m1','ses_a','{"role":"assistant","tokens":{"input":31000,"output":900,"cache":{"read":80000,"write":0}}}', ${now - 3000});
INSERT INTO message VALUES ('m2','ses_a','{"role":"assistant","tokens":{"input":97000,"output":1200,"cache":{"read":120000,"write":0}}}', ${now - 2500});
INSERT INTO message VALUES ('m3','ses_a','{"role":"user","tokens":{"input":5}}', ${now - 2400});
`);
  execSync(`sqlite3 ${JSON.stringify(db)} < ${JSON.stringify(join(root, "init.sql"))}`, { stdio: "ignore" });
  const rows = seatTokensReport({ dbPath: db, sinceMs: now - 30 * 86400000 });
  const qwen = rows.find(r => r.provider === "qwen");
  const zai = rows.find(r => r.provider === "zai-coding-plan");
  ok("#11559: the report groups qwen sessions, reads the JSON-model row, drops the 90-day one",
    rows.length === 2 && qwen && qwen.sessions === 2 && zai && zai.sessions === 1, JSON.stringify(rows));
  ok("#11559: token sums and cost roll up per provider",
    qwen.input === 300 && qwen.output === 30 && qwen.cacheRead === 1700 && qwen.cacheWrite === 10 && Math.abs(qwen.cost - 4) < 1e-9,
    JSON.stringify(qwen));
  ok("#11559: steps count assistant messages and peak names the biggest step",
    qwen.steps === 2 && qwen.peakInput === 97000, JSON.stringify({ steps: qwen.steps, peak: qwen.peakInput }));
  ok("#11559: rows sort by total tokens descending", rows[0] === qwen);
  ok("#11559: an unreadable DB is no data, never zeros", seatTokensReport({ dbPath: join(root, "missing.db"), sinceMs: now - 86400000 }).length === 0);
}

// ---- E2E: the budget pause, scoped to the card --------------------------------------------------
const CARDA = 9001, CARDB = 9002;
const sends = [];
let eventSeq = 0, handed = 0;
const cards = new Map([
  [CARDA, { id: CARDA, status: "doing", title: "long card" }],
  [CARDB, { id: CARDB, status: "todo", title: "other card" }],
]);
const hub = http.createServer((req, res) => {
  let buf = ""; req.on("data", c => (buf += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x"), P = u.pathname;
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "POST" && P === "/send") {
      try { sends.push(JSON.parse(buf)); eventSeq++; } catch {}
      return reply({ ok: true, id: sends.length });
    }
    if (P === "/card") {
      const t = cards.get(Number(u.searchParams.get("id") || 0));
      return reply({ ok: true, task: t ? { ...t } : null });
    }
    if (P === "/events") return reply({ events: [], cursor: eventSeq, latest: eventSeq });
    if (P === "/contracts") return reply({ contracts: [] });
    if (P === "/inbox") return reply({ messages: [], cursor: 0 });
    if (P === "/lessons") return reply({ lessons: [] });
    if (P === "/policy") return reply({ links: [], autonomy: { "*": 1 } });
    if (P === "/peer") return reply({ deliveredUpTo: 0 });
    if (P === "/poll") {
      const budgetAlerted = sends.some(s => /hit its token budget/.test(s.text || ""));
      if (handed === 0) { handed = 1; return reply({ messages: [{ id: 11, from: "sasha@mac", to: u.searchParams.get("session"), text: `contract: work card #${CARDA} for a long stretch`, ts: Date.now() }], cursor: 1 }); }
      if (handed === 1 && budgetAlerted) {
        handed = 2;
        return reply({ messages: [{ id: 12, from: "sasha@mac", to: u.searchParams.get("session"), text: `card #${CARDA}: one more step please`, ts: Date.now() }], cursor: 2 });
      }
      if (handed === 2 && budgetAlerted) {
        handed = 3;
        return reply({ messages: [{ id: 13, from: "sasha@mac", to: u.searchParams.get("session"), text: `contract: work card #${CARDB} instead`, ts: Date.now() }], cursor: 3 });
      }
      return setTimeout(() => reply({ messages: [], cursor: eventSeq }), 250);
    }
    return reply({ ok: true });
  });
});
await new Promise(r => hub.listen(0, "127.0.0.1", r));

{
  console.log("\n## a card past its token budget pauses, alerts once, and frees the next card");
  const root = mkdtempSync(join(SCRATCH, "tt-budget-"));
  const HOME = join(root, "home");
  const REPO = join(root, "repo");
  const BUS = join(HOME, ".agent-bus");
  mkdirSync(BUS, { recursive: true });
  mkdirSync(REPO, { recursive: true });
  mkdirSync(join(HOME, ".xdg"), { recursive: true });
  const g = (args) => execSync(`git ${args}`, { cwd: REPO, stdio: "ignore" });
  g("init -q -b main");
  writeFileSync(join(REPO, "seed.txt"), "seed\n");
  g("add -A");
  g("-c user.name=d -c user.email=d@d commit -qm init");
  const fakebin = join(root, "bin"); mkdirSync(fakebin, { recursive: true });
  const LOGF = join(root, "turns.log"), ENVF = join(root, "env-dump");
  const PROJ = "tt-budget";
  writeFileSync(join(fakebin, "codex"), `#!/bin/sh
P="$HOME/.agent-bus/turn-codex-${PROJ}.txt"
{ echo "===TURN==="; cat "$P"; } >> "${LOGF}"
echo "OpenAI Codex v2.3.4"
echo "tokens used: 5,000"
exit 0
`);
  writeFileSync(join(fakebin, "opencode"), `#!/bin/sh
env | grep '^OPENCODE_CONFIG_CONTENT=' > "${ENVF}" 2>/dev/null || true
echo "tokens used: 1"
exit 0
`);
  chmodSync(join(fakebin, "codex"), 0o755);
  chmodSync(join(fakebin, "opencode"), 0o755);
  const HUBADDR = `http://127.0.0.1:${hub.address().port}`;
  const RUNLOG = openSync(join(root, "runner.log"), "a");
  const runner = spawn("node", ["bin/crew-runner.mjs", "codex", REPO], {
    cwd: process.cwd(), stdio: ["ignore", RUNLOG, RUNLOG],
    env: { ...drillEnv({ TRANTOR_NO_DESKTOP_NOTIFY: "1" }), HOME, XDG_DATA_HOME: join(HOME, ".xdg"),
      PATH: `${fakebin}:${process.env.PATH}`, RELAY_URL: HUBADDR, RELAY_AGENT: "codex", RELAY_PROJECT: PROJ,
      TRANTOR_CARD_TOKEN_BUDGET: "4000", TRANTOR_RETRY_MS: "1200", CREW_KICKOFF: "say hi and end your turn" },
  });
  await sleep(26000);
  runner.kill("SIGKILL"); await sleep(150);
  const rlog = read(join(root, "runner.log"));
  const turns = read(LOGF).split("===TURN===").filter(t => t.includes("NEW BUS MESSAGE"));
  // The fake burns 5,000 tokens on EVERY turn, so card B crossing its own budget on its first
  // (and only) turn is CORRECT — each card carries its own counter. Scope the assertions to
  // card A: one alert pair (assigner + the orchestrator row, parkSeat's dual-send pattern),
  // and the paused card's redelivery never minting a second pair.
  const budgetSendsA = sends.filter(s => String(s.text || "").includes(`#${CARDA}`) && /hit its token budget/.test(s.text || ""));
  ok("#11559: exactly ONE budget alert reached the assigner for card A",
    budgetSendsA.filter(s => s.to === "sasha@mac").length === 1,
    JSON.stringify(budgetSendsA.map(s => ({ to: s.to, text: String(s.text).slice(0, 70) }))));
  ok("#11559: the orchestrator row also heard card A's alert once",
    budgetSendsA.filter(s => s.to !== "sasha@mac").length === 1,
    JSON.stringify(budgetSendsA.map(s => s.to)));
  ok("#11559: the alert names the card and both token numbers",
    budgetSendsA[0] && budgetSendsA[0].text.includes(`#${CARDA}`) && budgetSendsA[0].text.includes("5000") && budgetSendsA[0].text.includes("4000"),
    budgetSendsA[0] && budgetSendsA[0].text);
  ok("#11559: the alert names both ways out", budgetSendsA[0] && /trantor up codex/.test(budgetSendsA[0].text) && /until it moves/.test(budgetSendsA[0].text));
  ok("#11559: card A got exactly one turn — the second contract bought no CLI session; card B's did",
    turns.length === 2
    && turns[0].includes(`FRESH SESSION for card #${CARDA}`)
    && turns[1].includes(`FRESH SESSION for card #${CARDB}`),
    `turn markers: [${turns.map(t => (t.match(/FRESH SESSION for card #(\d+)/) || [])[1] || "?").join(", ")}]\n          runner log tail: ${rlog.split("\n").slice(-6).join(" | ")}`);
  ok("#11559: the paused card's redelivery never re-alerts", budgetSendsA.length === 2,
    `${budgetSendsA.length} card-A budget send(s)`);
}

console.log("\n## #11559: an opencode-family seat spawns with the compaction config injected");
{
  const root = mkdtempSync(join(SCRATCH, "tt-occompact-"));
  const HOME = join(root, "home");
  const REPO = join(root, "repo");
  mkdirSync(join(HOME, ".agent-bus"), { recursive: true });
  mkdirSync(join(HOME, ".xdg"), { recursive: true });
  mkdirSync(REPO, { recursive: true });
  const g = (args) => execSync(`git ${args}`, { cwd: REPO, stdio: "ignore" });
  g("init -q -b main");
  writeFileSync(join(REPO, "seed.txt"), "seed\n");
  g("add -A");
  g("-c user.name=d -c user.email=d@d commit -qm init");
  const fakebin = join(root, "bin"); mkdirSync(fakebin, { recursive: true });
  const ENVF = join(root, "env-dump");
  const PROJ = "tt-occompact";
  writeFileSync(join(fakebin, "opencode"), `#!/bin/sh
env | grep '^OPENCODE_CONFIG_CONTENT=' > "${ENVF}" 2>/dev/null || true
echo "tokens used: 1"
exit 0
`);
  chmodSync(join(fakebin, "opencode"), 0o755);
  const runner = spawn("node", ["bin/crew-runner.mjs", "opencode", REPO], {
    cwd: process.cwd(), stdio: "ignore",
    env: { ...drillEnv({ TRANTOR_NO_DESKTOP_NOTIFY: "1" }), HOME, XDG_DATA_HOME: join(HOME, ".xdg"),
      PATH: `${fakebin}:${process.env.PATH}`, RELAY_URL: `http://127.0.0.1:${hub.address().port}`,
      RELAY_AGENT: "opencode", RELAY_PROJECT: PROJ, CREW_KICKOFF: "say hi and end your turn" },
  });
  await sleep(9000);
  runner.kill("SIGKILL"); await sleep(150);
  const dumped = read(ENVF);
  ok("#11559: the pinned seat's spawn carries OPENCODE_CONFIG_CONTENT with the compaction block",
    dumped.includes("OPENCODE_CONFIG_CONTENT=") && dumped.includes('"compaction"') && dumped.includes('"reserved":64000'),
    dumped.slice(0, 160));
}
hub.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

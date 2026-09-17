#!/usr/bin/env node
// trantor hollow-turn drill (#7759) — exit 0 plus bytes on a stream is not work. A turn with NO
// worktree change (HEAD or porcelain vs turn start, untracked included) and NO substantive output
// beyond CLI chrome is EMPTY: logged, reported to the assigner as EMPTY (never "done"), its wake
// NOT consumed; second hollow attempt parks. The both-streams-silent rule (#5481) stays. Hermetic.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { drillEnv } from "../drill-env.mjs";
import { substantiveOutput, verdictFor, classifyFailure, SUBSTANTIVE_MIN } from "../../lib/classify-failure.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

console.log("# trantor hollow-turn drill (#7759)");

// ---- unit: what counts as substantive, and the classification ---------------------------------
console.log("\n## the rules");
{
  const banner = ["OpenAI Codex v2.3.4", "--------", "workdir: /tmp/x", "model: drill-1",
    "session: tt-1234", "provider: local", "tokens used: 1,337", "────────────────"].join("\n");
  ok("a CLI banner is chrome, not substantive output", !substantiveOutput(banner));
  ok("empty output is not substantive", !substantiveOutput(""));
  ok("a one-word ack is not substantive", !substantiveOutput("done."));
  const prose = "The gate passed on eab5766: 92 wake-policy assertions green, slop-gate clean, and the "
    + "worktree holds only the two committed files. Nothing else moved during the turn, so the "
    + "contract is satisfied and the card can move to testing.";
  ok(`prose of ${prose.length} chars (floor ${SUBSTANTIVE_MIN}) is substantive`, substantiveOutput(prose));
  ok("prose survives banner noise around it", substantiveOutput(banner + "\n" + prose));
  ok("verdictFor: exit 0 with work and no flag still reads success",
    verdictFor(0, 0, false, banner, false) === "classified success because exit 0 with CLI output");
  ok("#7759: verdictFor names the hollow turn, not success",
    /empty-turn/.test(verdictFor(0, 0, false, banner, true)),
    verdictFor(0, 0, false, banner, true));
  ok("#7759: classifyFailure gives the hollow turn its own reason and evidence",
    classifyFailure(0, "", false, true).reason === "empty-turn"
    && /no worktree change/.test(classifyFailure(0, "", false, true).matched));
  ok("the both-streams-silent rule keeps its reason (ordering unchanged)",
    classifyFailure(0, "", true, false).reason === "empty-output");
}

// ---- mock hub: hand out ONE direct contract, then stay silent forever --------------------------
const sends = [];
let served = 0, handed = 0;
const MSG = { id: 7, from: "sasha@mac", to: "", text: "contract: work card #7001 now", ts: Date.now() };
const hub = http.createServer((req, res) => {
  let buf = ""; req.on("data", c => (buf += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x"), P = u.pathname;
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "POST" && P === "/send") { try { sends.push(JSON.parse(buf)); } catch {} return reply({ ok: true, id: sends.length }); }
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

// ---- harness: the REAL runner + a fake `codex` ----------------------------------------------
// banner: CLI chrome, exit 0, touches nothing — the hollow specimen. edit: writes a NEW file into
// its cwd (the seat's git repo) every turn — real work. answer: prose past the substantive floor,
// touches nothing (#7766). HOME and the repo are SIBLINGS: the runner's files never pollute it.
async function drill(mode, { waitMs = 11000 } = {}) {
  sends.length = 0; handed = 0;
  const root = mkdtempSync(join(tmpdir(), "tt-hollow-"));
  const HOME = join(root, "home");
  const REPO = join(root, "repo");
  const BUS = join(HOME, ".agent-bus");
  mkdirSync(BUS, { recursive: true });
  mkdirSync(REPO, { recursive: true });
  execSync("git init -q", { cwd: REPO });
  const fakebin = join(root, "bin"); mkdirSync(fakebin, { recursive: true });
  const LOGF = join(root, "turns.log"), CNTF = join(root, "count");
  const PROJ = "tt-hollow";
  writeFileSync(join(fakebin, "codex"), `#!/bin/sh
P="$HOME/.agent-bus/turn-codex-${PROJ}.txt"
{ echo "===TURN==="; cat "$P"; } >> "${LOGF}"
if grep -q "NEW BUS MESSAGE" "$P"; then
  n=$(cat "${CNTF}" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${CNTF}"
  if [ "${mode}" = "edit" ]; then echo "drill work $n" > "touched-$n.txt"; fi
  if [ "${mode}" = "answer" ]; then
    echo "The gate passed on eab5766: 92 wake-policy assertions green, slop-gate clean, and the"
    echo "worktree holds only the two committed files. Nothing else moved during the turn, so"
    echo "the contract is satisfied and the card can move to testing with the counts attached."
  fi
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
      TRANTOR_RETRY_MS: "1200", CREW_KICKOFF: "say hi and end your turn" },
  });
  await sleep(waitMs);
  runner.kill("SIGKILL"); await sleep(150);
  const turns = read(LOGF).split("===TURN===").filter(t => t.trim());
  const rows = read(JSONL).split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } });
  return {
    turns, wakeTurns: turns.filter(t => t.includes("NEW BUS MESSAGE")), rows, handed,
    sends: [...sends], pendingLeft: existsSync(PENDF), PENDF,
  };
}

// ---- drill 1: banner CLI — exit 0, touches nothing -> EMPTY, wake NOT consumed, then PARK -----
console.log("\n## a banner is not work");
{
  const r = await drill("banner");
  ok("#7759: the hollow contract is attempted exactly twice, then parked — no third attempt",
    r.wakeTurns.length === 2, `got ${r.wakeTurns.length} wake turn(s)`);
  ok("#7759: the hub handed the message out ONCE — the second attempt is the runner's own queue",
    r.handed === 1, `handed ${r.handed}`);
  ok("#7759: attempt 2 is labelled a REDELIVERY", r.wakeTurns.filter(t => t.includes("REDELIVERY")).length === 1);
  const emptyNotices = r.sends.filter(s => s.to === "sasha@mac" && /EMPTY turn/.test(s.text || ""));
  ok("#7759: the assigner is told the turn was EMPTY, once",
    emptyNotices.length === 1, `${emptyNotices.length} notice(s)`);
  ok("#7759: the EMPTY notice names both signals (worktree, output)",
    emptyNotices.length === 1 && /no worktree change/.test(emptyNotices[0].text || "")
    && /no substantive output/.test(emptyNotices[0].text || ""), emptyNotices[0] && String(emptyNotices[0].text).slice(0, 160));
  ok("#7759: no done receipt went out for a hollow turn",
    !r.sends.some(s => s.to === "sasha@mac" && /✅ done on/.test(s.text || "")));
  ok("#7759: the wake is NOT consumed — the queue file survives the park", r.pendingLeft);
  const parks = r.sends.filter(s => s.to === "all" && /PARKED/.test(s.text || ""));
  ok("#7759: the second hollow attempt PARKS the seat, announced once, naming empty-turn",
    parks.length === 1 && /empty-turn/.test(parks[0].text || ""),
    parks[0] && String(parks[0].text).slice(0, 140));
  const row = r.rows.find(x => x.trigger === "direct message");
  ok("#7759: the telemetry row records outcome empty with the emptyTurn flag",
    row && row.outcome === "empty" && row.emptyTurn === true, JSON.stringify(row && { outcome: row.outcome, emptyTurn: row.emptyTurn, verdict: row.verdict }));
  ok("#7759: the verdict rides the telemetry row",
    row && /empty-turn/.test(row.verdict || ""));
}

// ---- drill 2: a CLI that edits a file is NOT hollow --------------------------------------------
console.log("\n## a changed worktree is work");
{
  const r = await drill("edit");
  ok("#7759: a turn that writes a file completes and consumes the wake",
    r.wakeTurns.length === 1, `got ${r.wakeTurns.length} wake turn(s)`);
  ok("#7759: the assigner hears done", r.sends.some(s => s.to === "sasha@mac" && /✅ done on/.test(s.text || "")));
  ok("#7759: no EMPTY notice for a working turn", !r.sends.some(s => /EMPTY turn/.test(s.text || "")));
  ok("#7759: the queue is cleared once the turn did work", !r.pendingLeft);
  const row = r.rows.find(x => x.trigger === "direct message");
  ok("#7759: telemetry outcome completed, emptyTurn false",
    row && row.outcome === "completed" && row.emptyTurn === false, JSON.stringify(row && { outcome: row.outcome, emptyTurn: row.emptyTurn }));
}

// ---- drill 3: a substantive ANSWER with no file change is NOT hollow (#7766's plain question) --
console.log("\n## a substantive answer is work");
{
  const r = await drill("answer");
  ok("#7759: a turn that answers past the chrome floor completes and consumes the wake",
    r.wakeTurns.length === 1, `got ${r.wakeTurns.length} wake turn(s)`);
  ok("#7759: the assigner hears done", r.sends.some(s => s.to === "sasha@mac" && /✅ done on/.test(s.text || "")));
  ok("#7759: the queue is cleared", !r.pendingLeft);
  ok("#7759: no park happened", !r.sends.some(s => /PARKED/.test(s.text || "")));
}

hub.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

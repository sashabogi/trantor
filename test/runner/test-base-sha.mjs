#!/usr/bin/env node
// #7754 drill: a contract carries the integration head as `base: <sha>` read from the orchestrator's
// LOCAL main, so a seat can resolve a sha that exists nowhere on origin; an explicit base this
// worktree cannot resolve blocks the card and reports on the bus, and no model turn is spent.
// Hermetic: a bare origin + a local repo one commit ahead, mock hub, fake CLI, REAL runner.
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { drillEnv } from "../drill-env.mjs";
import { contractBase, baseLine } from "../../bin/crew-payload.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

console.log("# trantor base-sha drill (#7754)");

// ---- unit: the line and its reader -------------------------------------------------------------
console.log("\n## the base line");
{
  ok("baseLine renders one line", baseLine("abc1234") === "base: abc1234");
  ok("no sha, no line", baseLine("") === "");
  ok("contractBase reads an explicit line off the wake", contractBase([{ text: "take #7001\nbase: 0123abc\nsmall" }]) === "0123abc");
  ok("the NEWEST base in the batch wins", contractBase([{ text: "base: aaaaaaa" }, { text: "correction\nbase: bbbbbbb" }]) === "bbbbbbb");
  ok("a later message without a base does not erase an earlier one", contractBase([{ text: "base: aaaaaaa" }, { text: "thanks" }]) === "aaaaaaa");
  ok("a branch name is not a base", contractBase([{ text: "base: origin/main" }]) === "");
  ok("no wake, no base", contractBase([]) === "");
}

// ---- the repo: origin holds c0; local main holds c1 that origin has never seen -------------------
const W = mkdtempSync(join(tmpdir(), "tt-base-"));
const ORIGIN = join(W, "origin.git"), REPO = join(W, "work");
const git = (cwd, args) => execFileSync("git", ["-c", "user.name=drill", "-c", "user.email=drill@x", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
mkdirSync(ORIGIN); git(ORIGIN, ["init", "-q", "--bare", "-b", "main"]);
mkdirSync(REPO); git(REPO, ["init", "-q", "-b", "main"]);
writeFileSync(join(REPO, "a.txt"), "c0\n");
git(REPO, ["add", "a.txt"]); git(REPO, ["commit", "-q", "-m", "c0"]);
git(REPO, ["remote", "add", "origin", ORIGIN]); git(REPO, ["push", "-q", "-u", "origin", "main"]);
writeFileSync(join(REPO, "a.txt"), "c1\n");
git(REPO, ["commit", "-q", "-am", "c1 (integration, unpushed)"]);
const C0 = git(REPO, ["rev-parse", "origin/main"]), C1 = git(REPO, ["rev-parse", "main"]);
ok("setup: local main is ahead of origin/main", C0 !== C1 && git(REPO, ["rev-parse", "HEAD"]) === C1);
const GHOST = "0123456789abcdef0123456789abcdef01234567";

// ---- the runner, against a mock hub -------------------------------------------------------------
let queued = [], served = 0, sent = [], moves = [];
const hub = http.createServer((req, res) => {
  let buf = ""; req.on("data", c => (buf += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x"), P = u.pathname;
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (P === "/inbox") return reply({ messages: [], cursor: 0 });
    if (P === "/lessons") return reply({ lessons: [] });
    if (P === "/policy") return reply({ links: [], autonomy: { "*": 1 } });
    if (P === "/send") { try { sent.push(JSON.parse(buf || "{}")); } catch {} return reply({ ok: true, id: sent.length }); }
    if (P === "/task/update") { try { moves.push(JSON.parse(buf || "{}")); } catch {} return reply({ ok: true }); }
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
const PROJ = "tt-base";

// The fake seat logs the prompt it was handed and resolves the prompt's base line from ITS cwd —
// the seat worktree the runner made under HOME — exactly as a real seat would with git cat-file.
async function drill(messages, { waitMs = 8000 } = {}) {
  queued = messages; served = 0; sent = []; moves = [];
  const HOME = join(W, `home-${Date.now()}`);
  mkdirSync(join(HOME, ".agent-bus"), { recursive: true });
  const fakebin = join(HOME, "bin"); mkdirSync(fakebin, { recursive: true });
  const LOGF = join(HOME, "turns.log");
  writeFileSync(join(fakebin, "codex"), `#!/bin/sh
P="$HOME/.agent-bus/turn-codex-${PROJ}.txt"
{ echo "===TURN=== mode=$1 cwd=$PWD"; cat "$P"; } >> "${LOGF}"
SHA=$(grep -E '^base: [0-9a-f]+$' "$P" | tail -1 | cut -d' ' -f2)
if [ -n "$SHA" ]; then
  if git cat-file -e "$SHA^{commit}" 2>/dev/null; then echo "seat resolved base $SHA: yes" >> "${LOGF}"; else echo "seat resolved base $SHA: no" >> "${LOGF}"; fi
fi
echo "codex-drill: turn done"
exit 0
`);
  chmodSync(join(fakebin, "codex"), 0o755);
  const runner = spawn("node", ["bin/crew-runner.mjs", "codex", REPO], {
    cwd: process.cwd(), stdio: "ignore",
    env: { ...drillEnv(), HOME, PATH: `${fakebin}:${process.env.PATH}`,
      RELAY_URL: HUB, RELAY_AGENT: "codex", RELAY_PROJECT: PROJ,
      CREW_KICKOFF: "say hi and end your turn" },
  });
  await sleep(waitMs);
  runner.kill("SIGKILL"); await sleep(150);
  const log = read(LOGF);
  const turns = log.split("===TURN===").filter(t => t.trim());
  return { log, turns, wakeTurns: turns.filter(t => t.includes("NEW BUS MESSAGE")), sent, moves };
}

// ---- drill 1: a contract naming only a card gets the LOCAL main head, which origin lacks ----------
console.log("\n## the contract carries local main, and the seat resolves it");
{
  const r = await drill([{ text: "contract: card #7001, build the thing" }]);
  ok("the contract buys one turn", r.wakeTurns.length === 1, `${r.wakeTurns.length} wake turn(s)`);
  const t = r.wakeTurns[0] || "";
  ok("the turn carries `base: <local main sha>`, not origin/main's", t.includes(`\nbase: ${C1}\n`) && !t.includes(C0), t.slice(0, 400));
  ok("the fake seat resolved that sha from its own worktree", r.log.includes(`seat resolved base ${C1}: yes`), r.log.slice(-300));
  ok("the seat worktree is a linked worktree of the same repo (the ref `main` is right there)",
    /cwd=.*\.agent-bus\/worktrees\/tt-base\/codex/.test(t), t.slice(0, 120));
  ok("the rules tell the seat: start at the base sha, never at origin/main",
    t.includes("never at origin/main") && t.includes("verified at <sha>"), "rules text missing the #7754 lines");
  ok("nothing was moved to blocked", !r.moves.some(m => m.status === "blocked"), JSON.stringify(r.moves));
}

// ---- drill 2: an explicit base this worktree cannot resolve -> blocked + report, no turn ----------
console.log("\n## an unresolvable base blocks the card");
{
  const r = await drill([{ text: `contract: card #7002, build it\nbase: ${GHOST}` }]);
  ok("no model turn is spent on it", r.wakeTurns.length === 0, `${r.wakeTurns.length} wake turn(s)`);
  const blocked = r.moves.find(m => Number(m.id) === 7002 && m.status === "blocked");
  ok("#7002 is moved to blocked with the reason in the note", !!blocked && new RegExp(`^cannot resolve base ${GHOST}`).test(blocked.note || ""), JSON.stringify(r.moves));
  const report = r.sent.find(m => new RegExp(`^cannot resolve base ${GHOST}`).test(m.text || ""));
  ok("the assigner is told on the bus, in those words", !!report && report.to === "sasha@mac", JSON.stringify(r.sent.map(m => ({ to: m.to, text: (m.text || "").slice(0, 80) }))));
  ok("the wake is consumed — the seat does not re-block on every poll", r.moves.filter(m => m.status === "blocked").length === 1, `${r.moves.length} move(s)`);
}

// ---- drill 3: an explicit base the worktree CAN resolve is honoured over local main ---------------
console.log("\n## an explicit resolvable base is honoured");
{
  const r = await drill([{ text: `contract: card #7003, build it\nbase: ${C0}` }]);
  ok("the contract buys one turn", r.wakeTurns.length === 1, `${r.wakeTurns.length} wake turn(s)`);
  ok("the turn carries the orchestrator's explicit base, not local main", (r.wakeTurns[0] || "").includes(`\nbase: ${C0}\n`), (r.wakeTurns[0] || "").slice(0, 300));
  ok("nothing was moved to blocked", !r.moves.some(m => m.status === "blocked"), JSON.stringify(r.moves));
}

hub.close();
rmSync(W, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

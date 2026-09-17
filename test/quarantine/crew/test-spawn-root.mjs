#!/usr/bin/env node
// trantor crew SPAWN-ROOT drill (#6154): the runner must pin --dir to the seat worktree on every
// opencode-family spawn, because a globally-resumed session's stored directory becomes the root
// for relative paths and the seat's own worktree then reads as external_directory.
// Hermetic (#7771): mock hub + fake opencode (leaving the DB rows the real CLI would) + a node:sqlite shim in for the sqlite3 CLI — asserts the argv the runner BUILDS, not the machine's installs.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { drillEnv } from "../../drill-env.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : ` — ${extra}`}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("# trantor crew spawn-root drill (#6154)");

// ---- mock hub: one queued message per /poll, records /register -------------------------
async function mockHub() {
  let inboxQueue = [];
  const hub = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      const u = new URL(req.url, "http://x");
      const P = u.pathname;
      const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.method === "POST" && P === "/register") return reply({ ok: true, session: "x", peers: [] });
      if (req.method === "POST" && P === "/send") return reply({ ok: true, id: 1 });
      if (P === "/inbox") return reply({ messages: [], cursor: 0 });
      // #7763/#7765: a wake's card binding needs the board to CONFIRM the cited id — an
      // unconfirmed citation binds nothing and the turn resumes instead of starting fresh, so the
      // mock board confirms every id the drill cites.
      if (P === "/card") return reply({ task: { id: Number(u.searchParams.get("id")), title: "drill card", status: "doing", assignee: "" } });
      if (P === "/poll") {
        const m = inboxQueue.splice(0, 1);
        return reply({ messages: m, cursor: (Number(u.searchParams.get("since")) || 0) + m.length });
      }
      if (P === "/lessons") return reply({ lessons: [] });
      return reply({ ok: true });
    });
  });
  await new Promise((r) => hub.listen(0, "127.0.0.1", r));
  // A same-project host (#6228): a wake whose sender lives in another project is dropped without
  // acting, so the drill's host speaks from the seat's own project — the shape a real
  // orchestrator/contract wake has. "host:drill" used to fail the fence and every queued message
  // starved, leaving one spawn where five were owed (#7771).
  return { hub, queue: (msgs, agent, proj) => { inboxQueue = msgs.map((text, i) => ({ id: i + 1, from: `host:${proj}`, to: `${agent}:${proj}`, text, project: proj })); } };
}

// ---- the fake opencode: records cwd + argv, leaves DB rows like the real CLI -----------
// The real opencode writes every session into ~/.local/share/opencode/opencode.db with the
// directory it was created in — that table is what the runner's pinned resume looks up, so the
// fake reproduces exactly that side effect (fresh runs only; a resume reuses the session).
const FAKE = `#!/bin/sh
echo "$PWD" >> "$OC_LOG"
printf '%s' "$*" | tr '\\n' ' ' >> "$OC_ARGS"
echo "$PWD" >> "$OC_ARGS"
# >= SUBSTANTIVE_MIN (120) chars of plain output: a shorter turn reads as EMPTY (#7759) and the
# runner stops consuming the wake — the drill would starve on redelivery backoff instead of
# exercising the five spawns its assertions count.
echo "worked the contract: read the cited card, edited the pinned file under the seat worktree, reran the checks, recorded the outcome on the bus."
case " $* " in *" -s "*) ;; *)
  [ "$OC_NODB" = "1" ] && exit 0
  db="$HOME/.local/share/opencode/opencode.db"
  mkdir -p "$(dirname "$db")"
  n=$(cat "$OC_CNT" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$OC_CNT"
  sqlite3 "$db" "CREATE TABLE IF NOT EXISTS session (id text PRIMARY KEY, directory text NOT NULL, time_updated integer NOT NULL);"
  sqlite3 "$db" "INSERT INTO session (id, directory, time_updated) VALUES ('ses_drill$(printf %04d $n)', '$PWD', $(( $(date +%s) * 1000 + $n )));"
  ;;
esac
exit 0`;

async function drill(agent, inboxMsgs, opts = {}) {
  const { hub, queue } = await mockHub();
  const HUB = `http://127.0.0.1:${hub.address().port}`;
  const PROJ = `tt-spawn-${agent}`;
  queue(inboxMsgs, agent, PROJ);

  const work = mkdtempSync(join(tmpdir(), `tt-spawn-${agent}-`));
  const fakebin = join(work, "bin");
  mkdirSync(fakebin, { recursive: true });
  writeFileSync(join(fakebin, "opencode"), FAKE);
  chmodSync(join(fakebin, "opencode"), 0o755);

  // The runner's sid lookup shells out to the sqlite3 CLI, and the fake's DB writes used to call
  // it too — a machine without that binary degraded every resume turn to fresh and the pin
  // assertions lied about the code under test. The shim answers the exact CLI surface both use
  // (-readonly <db> <sql>, one statement per call, rows as `|`-joined values) from node:sqlite.
  const SQLITE3_SHIM = `#!/bin/sh
ro=0
[ "$1" = "-readonly" ] && { ro=1; shift; }
db="$1"; shift
RO="$ro" exec node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: process.env.RO === "1" });
for (const stmt of process.argv[2].split(";")) {
  const q = stmt.trim();
  if (!q) continue;
  const r = db.prepare(q);
  if (/^select/i.test(q)) for (const row of r.all()) console.log(Object.values(row).join("|"));
  else r.run();
}
' "$db" "$*"
`;
  writeFileSync(join(fakebin, "sqlite3"), SQLITE3_SHIM);
  chmodSync(join(fakebin, "sqlite3"), 0o755);

  const HOME = join(work, "home");
  mkdirSync(join(HOME, ".agent-bus"), { recursive: true });
  const OC_LOG = join(work, "cwds.txt"), OC_ARGS = join(work, "argvs.txt"), OC_CNT = join(work, "count.txt");
  writeFileSync(OC_LOG, ""); writeFileSync(OC_ARGS, "");

  const env = { ...drillEnv(), HOME, PATH: `${fakebin}:${process.env.PATH}`,
                RELAY_URL: HUB, RELAY_AGENT: agent, RELAY_PROJECT: PROJ,
                OC_LOG, OC_ARGS, OC_CNT,
                CREW_KICKOFF: "say hi and end your turn" };
  if (opts.noDb) env.OC_NODB = "1";

  const runner = spawn("node", ["bin/crew-runner.mjs", agent, work], {
    cwd: process.cwd(),
    env,
    stdio: "ignore",
  });

  const turns = async (n, ms = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const lines = existsSync(OC_LOG) ? readFileSync(OC_LOG, "utf8").split("\n").filter(Boolean) : [];
      if (lines.length >= n) break;
      await sleep(150);
    }
    runner.kill("SIGKILL");
    hub.close();
    await sleep(150);
    const cwds = readFileSync(OC_LOG, "utf8").split("\n").filter(Boolean);
    const argvs = readFileSync(OC_ARGS, "utf8").split("\n").filter(Boolean);
    return { work, cwds, argvs };
  };
  return turns;
}

// Every reader below takes what the argv file actually recorded — a short spawn list must report
// a red row, never a TypeError that kills the suite before its real red is shown (#7771).
const pin = (a) => (String(a ?? "").match(/-s (ses_[A-Za-z0-9]+)/) || [])[1] || "";
const hasDir = (a, work) => String(a ?? "").includes(`--dir ${work}`);
const hasResumeC = (a) => /(^|\s)-c(\s|$)/.test(String(a ?? ""));
// macOS hands node a /var/folders/... tmpdir while a shell's $PWD there is the /private/var
// realpath — compare the fake's recorded cwd against the realpath of the work dir.
const realWork = (work) => { try { return realpathSync(work); } catch { return work; } };

// ---- case A: kickoff + 4 card-citing messages → fresh/fresh/RESUME/fresh/RESUME --------
{
  const turns = await drill("glm", [
    "card #100: first task",
    "card #100: second task, same card",
    "card #200: different card entirely",
    "card #200: still card 200",
  ]);
  const { work, cwds, argvs } = await turns(5, 60000);

  ok("all five turns ran in the seat worktree (opencode's cwd IS the worktree)",
     cwds.length === 5 && cwds.every((c) => c === realWork(work)), `${cwds.length} turns: ${cwds.join(" | ")}`);
  ok("every spawn pins --dir to the seat worktree",
     argvs.length === 5 && argvs.every((a) => hasDir(a, work)), argvs.map((a) => a.slice(0, 60)).join(" | "));
  ok("no spawn carries the global `-c` resume — the bug that resumed a stranger's session",
     argvs.every((a) => !hasResumeC(a)), argvs.join(" | "));

  const [t1, t2, t3, t4, t5] = argvs;
  ok("turn 1 (kickoff) is a fresh session: no -s", !pin(t1), t1.slice(0, 80));
  ok("turn 2 (new card #100) is a FRESH session per card: no -s", !pin(t2), t2.slice(0, 80));
  ok("turn 3 (same card #100) pins -s to a session id", /^ses_/.test(pin(t3)), t3.slice(0, 80));
  ok("turn 4 (card change #100→#200) drops the old session: no -s", !pin(t4), t4.slice(0, 80));
  ok("turn 5 (same card #200) pins -s again", /^ses_/.test(pin(t5)), t5.slice(0, 80));
  ok("each card's pinned session is a DIFFERENT session id",
     pin(t3) !== pin(t5), `${pin(t3)} vs ${pin(t5)}`);
}

// ---- case B: no opencode DB at all → fail-open to FRESH, never to a foreign resume ----
{
  const turns = await drill("deepseek", [
    "card #300: task one",
    "card #300: task two",
  ], { noDb: true });
  const { work, cwds, argvs } = await turns(3, 60000);

  ok("with no opencode DB, all three turns still ran in the worktree",
     cwds.length === 3 && cwds.every((c) => c === realWork(work)), `${cwds.length} turns`);
  ok("with no opencode DB, every spawn still pins --dir",
     argvs.every((a) => hasDir(a, work)), argvs.map((a) => a.slice(0, 60)).join(" | "));
  ok("with no opencode DB, no spawn ever falls back to `-c` (fresh is safe, -c is not)",
     argvs.every((a) => !hasResumeC(a) && !pin(a)), argvs.join(" | "));
}

console.log(`\nspawn-root drills: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// agent-bus crew runner — keeps a crew agent alive forever without burning tokens.
//
//   node crew-runner.mjs <agent> [project-dir]
//
// The park problem: CLIs end their turn no matter what you prompt (harnesses actively kill
// "call relay_wait repeatedly" loops). So the runner owns the waiting: it long-polls the bus
// over plain HTTP (zero tokens, doubles as a heartbeat), and when a message addressed to this
// agent arrives it RESUMES the CLI session (native resume = full context kept) with that
// message as the prompt. The model just works and ends its turn; the runner does the rest.
import { execSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const AGENT = process.argv[2];
const DIR = process.argv[3] || process.cwd();
const PROJ = basename(DIR);
const SESSION = `${AGENT}:${PROJ}`;
if (!AGENT) { console.error("usage: crew-runner.mjs <agent> [project-dir]"); process.exit(1); }

function hubUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL;
  try { const u = JSON.parse(readFileSync(join(homedir(), ".agent-bus", "config.json"), "utf8")).url; if (u) return u; } catch {}
  return "http://127.0.0.1:4477";
}
const HUB = hubUrl();
process.on("uncaughtException", (e) => { console.log(`\x1b[31m[runner] UNCAUGHT: ${e?.stack || e}\x1b[0m`); });
process.on("unhandledRejection", (e) => { console.log(`\x1b[31m[runner] UNHANDLED REJECTION: ${e?.stack || e}\x1b[0m`); });
const log = (s) => console.log(`\x1b[38;5;43m[runner]\x1b[0m ${s}`);
const LOGDIR = join(homedir(), ".agent-bus", "logs");
import { mkdirSync } from "node:fs";
try { mkdirSync(LOGDIR, { recursive: true }); } catch {}
let TURN = 0;
const telemetry = (rec) => { try { appendFileSync(join(LOGDIR, `${AGENT}-${PROJ}.jsonl`), JSON.stringify(rec) + "\n"); } catch {} };
const banner = (trigger) => {
  console.log(`\x1b[2J\x1b[H\x1b[48;5;236m\x1b[38;5;43m  ◤ ${AGENT.toUpperCase()} ◢  agent-bus crew · ${PROJ} · turn ${TURN} · ${trigger}${MODEL ? ` · ${MODEL}` : ""}  \x1b[0m\n`);
};

async function api(path, body) {
  const opts = body
    ? { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify(body) }
    : { headers: { connection: "close" } };   // fresh socket per call — long-polls on stale keep-alive sockets reset
  const r = await fetch(HUB + path, opts);
  return r.json();
}

// ---- per-CLI invocation (first turn vs resume turn). {P} = prompt file path ----
// CREW_MODEL env pins the model: each CLI gets its own flag via {M} (empty when unset).
let MODEL = process.env.CREW_MODEL || "";
// opencode expects provider/model — qualify bare ids for the deepseek/opencode agents
if (MODEL && !MODEL.includes("/") && (AGENT === "deepseek" || AGENT === "opencode")) MODEL = `deepseek/${MODEL}`;
const CLI = {
  codex:    { first: `codex exec{M} --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "$(cat {P})" < /dev/null`,
              next:  `codex exec resume --last{M} --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "$(cat {P})" < /dev/null`, mflag: " -m " },
  gemini:   { first: `gemini --yolo{M} -p "$(cat {P})"`,
              next:  `gemini --yolo{M} -r latest -p "$(cat {P})"`, mflag: " -m " },
  kimi:     { first: `kimi --print --yolo{M} -p "$(cat {P})" < /dev/null`,
              next:  `kimi --print --yolo{M} -r {SID} -p "$(cat {P})" < /dev/null`, mflag: " --model ", sid: /To resume this session: kimi -r ([a-f0-9-]+)/ },
  deepseek: { first: `opencode run{M} "$(cat {P})"`,
              next:  `opencode run -c{M} "$(cat {P})"`, mflag: " -m ", env: join(homedir(), ".token-scrooge", ".env") },
  opencode: { first: `opencode run{M} "$(cat {P})"`,
              next:  `opencode run -c{M} "$(cat {P})"`, mflag: " -m ", env: join(homedir(), ".token-scrooge", ".env") },
  claude:   { first: `claude{M} -p "$(cat {P})" --dangerously-skip-permissions`,
              next:  `claude -c{M} -p "$(cat {P})" --dangerously-skip-permissions`, mflag: " --model " },
};
const cli = CLI[AGENT];
if (!cli) { console.error(`unknown agent '${AGENT}' (known: ${Object.keys(CLI).join(", ")})`); process.exit(1); }

const RULES = `Rules: you are ${SESSION} on the agent-bus crew. Work your assigned file(s), report on the bus (relay_send, <280 chars), move your Kanban card as you go (doing -> testing -> done; run the tests in 'testing', use 'failed' + a report if they break). When your work for THIS message is finished, END YOUR TURN — do NOT park, do NOT loop relay_wait; the runner waits for you and will wake you with the next message.`;

let sid = "";
function runTurn(prompt, isFirst, trigger = "kickoff") {
  TURN++; banner(trigger);
  const t0 = Date.now();
  const pf = join(homedir(), ".agent-bus", `turn-${AGENT}-${PROJ}.txt`);
  appendFileSync(pf, "", { flag: "w" }); // truncate
  appendFileSync(pf, prompt);
  let cmd = (isFirst || (cli.sid && !sid)) ? cli.first : cli.next;
  const mfrag = MODEL && cli.mflag ? `${cli.mflag}${MODEL}` : "";
  cmd = cmd.replaceAll("{M}", mfrag).replaceAll("{P}", pf).replaceAll("{SID}", sid);
  const envs = [join(homedir(), ".agent-bus", ".env"), cli.env].filter(f => f && existsSync(f));
  for (const f of envs.reverse()) cmd = `set -a; source ${f}; set +a; ${cmd}`;   // ~/.agent-bus/.env wins
  log(`turn starting (${isFirst ? "fresh session" : "resume"})${MODEL ? ` · model=${MODEL}` : ""}`);
  // inherit stdio so the window shows the agent working live; also capture for sid-parsing
  const r = spawnSync("/bin/bash", ["-c", cli.sid ? `${cmd} | tee /dev/stderr` : cmd], {
    cwd: DIR, encoding: "utf8", stdio: cli.sid ? ["ignore", "pipe", "inherit"] : "inherit",
    env: { ...process.env, RELAY_URL: HUB, RELAY_AGENT: AGENT, RELAY_PROJECT: PROJ },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (cli.sid && r.stdout) { const m = r.stdout.match(cli.sid); if (m) sid = m[1]; }
  telemetry({ ts: Date.now(), agent: AGENT, project: PROJ, turn: TURN, trigger, model: MODEL || "default", duration_ms: Date.now() - t0, exit: r.status });
  log(`turn ended (exit ${r.status}, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  return r.status;
}

// ---- main loop ----
const KICKOFF = process.env.CREW_KICKOFF ||
  `You just joined. 1) relay_send to "all": "${AGENT} reporting — ready for a contract". 2) relay_inbox — if a contract for you is already waiting, do it now per the Rules. 3) End your turn.\n\n${RULES}`;

let LESSONS = "";
async function loadLessons() {
  try {
    const { lessons } = await api(`/lessons?agent=${encodeURIComponent(AGENT)}`);
    if (lessons?.length) LESSONS = "\n\nLESSONS from previous crews (hard-won — follow them):\n" + lessons.map(l => `- [${l.scope}] ${l.text}`).join("\n");
  } catch {}
}

(async () => {
  await loadLessons();
  // start cursor at the CURRENT tip so we don't replay history
  let cursor = 0;
  try { const r = await api(`/inbox?session=${encodeURIComponent(SESSION)}&since=0`); cursor = r.cursor || 0; } catch {}
  await api("/register", { session: SESSION, project: PROJ, status: "crew member booting" }).catch(() => {});

  let pendingBcast = [];
  runTurn(KICKOFF + LESSONS, true, "kickoff");
  log(`parked — long-polling the bus as ${SESSION} (free; this poll is also the heartbeat)`);

  while (true) {
    let msgs = [];
    try {
      const r = await api(`/poll?session=${encodeURIComponent(SESSION)}&since=${cursor}&wait=280`);
      msgs = r.messages || []; cursor = r.cursor ?? cursor;
    } catch (e) { log(`hub unreachable (${e.message}) — retrying in 5s`); await new Promise(s => setTimeout(s, 5000)); continue; }
    if (!msgs.length) continue;                       // heartbeat tick, nothing for us
    const direct = msgs.filter(m => m.to === SESSION);
    const mentions = msgs.filter(m => m.to === "all" && (m.text.includes(`@${AGENT}`) || m.text.toLowerCase().includes(`${AGENT}:`)));
    const bcast = msgs.filter(m => m.to === "all" && !mentions.includes(m));
    pendingBcast.push(...bcast);                      // wake-policy: plain broadcasts batch, they don't wake
    const wake = [...direct, ...mentions];
    if (!wake.length) { if (bcast.length) log(`${bcast.length} broadcast(s) batched (no wake) — ${pendingBcast.length} pending`); continue; }
    const ctx = pendingBcast.length ? `\nFYI broadcasts since your last turn (context only):\n${pendingBcast.map(m => `[${m.from} -> all]: ${m.text}`).join("\n")}\n` : "";
    pendingBcast = [];
    const lines = wake.map(m => `[${m.from}${m.to === "all" ? " -> all (mentions you)" : ""}]: ${m.text}`).join("\n");
    const prompt = `NEW BUS MESSAGE${wake.length > 1 ? "S" : ""} for you:\n${lines}\n${ctx}\nAct on what's addressed to you, then end your turn.\n\n${RULES}`;
    await loadLessons(); runTurn(prompt + LESSONS, false, direct.length ? "direct message" : "@mention");
    log("parked — waiting for the next message");
  }
})();

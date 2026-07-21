#!/usr/bin/env node
// trantor crew runner — keeps a crew agent alive forever without burning tokens.
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
import { resolveProject } from "../lib/project.mjs";

const AGENT = process.argv[2];
const DIR = process.argv[3] || process.cwd();
// Crew agents MUST share the orchestrator's project key (one repo = one lane).
// RELAY_PROJECT is inherited from crew.sh (the host's resolved key); else fall
// back to the git-repo-root basename — never a loose dir basename that could
// fork the host's "builtbetter.ai" into a separate "builtbetter" lane.
const PROJ = process.env.RELAY_PROJECT || resolveProject(DIR);
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
  console.log(`\x1b[2J\x1b[H\x1b[48;5;236m\x1b[38;5;43m  ◤ ${AGENT.toUpperCase()} ◢  trantor crew · ${PROJ} · turn ${TURN} · ${trigger}${MODEL ? ` · ${MODEL}` : ""}  \x1b[0m\n`);
};

async function api(path, body) {
  const opts = body
    ? { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify(body) }
    : { headers: { connection: "close" } };   // fresh socket per call — long-polls on stale keep-alive sockets reset
  const r = await fetch(HUB + path, opts);
  return r.json();
}

// ---- cmux sidebar integration ----
// When this runner is inside a cmux surface (CMUX_SURFACE_ID is auto-set there), push its live state into
// cmux's sidebar for THIS seat. An inside process is allowed by cmux's default cmuxOnly socket mode — no
// allowAll needed. Fail-silent + short timeout; must never block or slow a turn.
const CMUX_BIN = process.env.CMUX_BIN
  || (existsSync("/Applications/cmux.app/Contents/Resources/bin/cmux") ? "/Applications/cmux.app/Contents/Resources/bin/cmux" : "cmux");
const inCmux = () => !!process.env.CMUX_SURFACE_ID;
function cmuxStatus(value, color, icon = "robot") {
  if (!inCmux()) return;
  try { spawnSync(CMUX_BIN, ["set-status", "trantor", value, "--color", color, "--icon", icon], { stdio: "ignore", timeout: 1500, env: { ...process.env, CMUX_QUIET: "1" } }); } catch {}
}
function cmuxLog(message, level = "info") {
  if (!inCmux()) return;
  try { spawnSync(CMUX_BIN, ["log", String(message).slice(0, 200), "--level", level], { stdio: "ignore", timeout: 1500, env: { ...process.env, CMUX_QUIET: "1" } }); } catch {}
}

// ---- per-CLI invocation (first turn vs resume turn). {P} = prompt file path ----
// CREW_MODEL env pins the model: each CLI gets its own flag via {M} (empty when unset).
let MODEL = process.env.CREW_MODEL || "";
// opencode expects provider/model. A BARE id for the `deepseek` agent qualifies to its
// own provider; `opencode` ids must already be provider-qualified (e.g.
// `zai-coding-plan/glm-5.1`) — never assume `deepseek/` for opencode (that mangled
// ZAI-coding-plan models into deepseek/…). `scrooge route` returns qualified ids.
if (MODEL && !MODEL.includes("/") && AGENT === "deepseek") MODEL = `deepseek/${MODEL}`;
const CLI = {
  codex:    { first: `codex exec{M} --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "$(cat {P})" < /dev/null`,
              next:  `codex exec resume --last{M} --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "$(cat {P})" < /dev/null`, mflag: " -m " },
  gemini:   { first: `gemini --yolo{M} -p "$(cat {P})"`,
              next:  `gemini --yolo{M} -r latest -p "$(cat {P})"`, mflag: " -m " },
  // kimi-code (successor to kimi-cli) has no --print (-p alone is non-interactive), REJECTS
  // --yolo in prompt mode (prompt mode auto-approves tools), and emits session_-prefixed ids.
  kimi:     { first: `kimi{M} -p "$(cat {P})" < /dev/null`,
              next:  `kimi{M} -r {SID} -p "$(cat {P})" < /dev/null`, mflag: " --model ", sid: /To resume this session: kimi -r (\S+)/ },
  deepseek: { first: `opencode run{M} "$(cat {P})"`,
              next:  `opencode run -c{M} "$(cat {P})"`, mflag: " -m ", env: join(homedir(), ".token-scrooge", ".env") },
  opencode: { first: `opencode run{M} "$(cat {P})"`,
              next:  `opencode run -c{M} "$(cat {P})"`, mflag: " -m ", env: join(homedir(), ".token-scrooge", ".env") },
  // OpenRouter rides the opencode CLI exactly like deepseek/glm, but under its OWN agent label so
  // its bus identity is `openrouter:<project>` (RELAY_AGENT is set per-spawn) — never colliding with
  // the glm `opencode` seat. Model ids come pre-qualified (`openrouter/<vendor>/<model>`). Sources
  // the token-scrooge .env so an existing OPENROUTER_API_KEY authenticates with no extra wiring.
  openrouter: { first: `opencode run{M} "$(cat {P})"`,
              next:  `opencode run -c{M} "$(cat {P})"`, mflag: " -m ", env: join(homedir(), ".token-scrooge", ".env") },
  claude:   { first: `claude{M} -p "$(cat {P})" --dangerously-skip-permissions`,
              next:  `claude -c{M} -p "$(cat {P})" --dangerously-skip-permissions`, mflag: " --model " },
};
// BYOM: any agent label that isn't a known native CLI is treated as an opencode-driven provider
// seat (opencode is the universal adapter). This is what lets a BROUGHT provider — `trantor up
// <label>:<provider>` for any opencode vendor the user configured — run with no per-provider code
// here; its model id arrives pre-qualified (`<provider>/<model>`) as CREW_MODEL.
const NATIVE = new Set(["codex", "gemini", "kimi", "claude"]);
const cli = CLI[AGENT] || (NATIVE.has(AGENT) ? null : CLI.opencode);
if (!cli) { console.error(`unknown agent '${AGENT}' (native: ${[...NATIVE].join(", ")}; any other name = an opencode provider seat)`); process.exit(1); }
if (!CLI[AGENT]) log(`'${AGENT}' is not a built-in seat — running it as an opencode provider (BYOM)`);

const RULES = `Rules: you are ${SESSION} on the trantor crew. Work your assigned file(s), report on the bus (relay_send, <280 chars), move your Kanban card as you go (doing -> testing -> done; run the tests in 'testing', use 'failed' + a report if they break). When your work for THIS message is finished, END YOUR TURN — do NOT park, do NOT loop relay_wait; the runner waits for you and will wake you with the next message.`;

// ---- failure visibility ----------------------------------------------------
// A turn's CLI can fail (credits exhausted, auth, crash) and the runner would just
// re-park — staying green on the bus, telling the orchestrator NOTHING. These surface
// every non-zero turn to the bus in real time so the orchestrator (and `trantor swap`)
// can react, and flip presence to errored/down.
let consecFails = 0;
let lastErrText = "";
const ERRF = join(homedir(), ".agent-bus", `err-${AGENT}-${PROJ}.txt`);

function classifyFailure(exit, errText) {
  const t = (errText || "").toLowerCase();
  if (exit === 127) return "missing-cli";
  if (/quota|insufficient|credit|balance|payment required|402|429|too many requests|rate.?limit|exceeded your|out of (credit|quota)/.test(t)) return "exhausted";
  if (/unauthor|401|invalid[ _-]?api[ _-]?key|forbidden|403|token expired|expired/.test(t)) return "auth";
  return "crashed";
}

async function reportFailure(exit, trigger) {
  consecFails++;
  const reason = classifyFailure(exit, lastErrText);
  const down = consecFails >= 2;
  const status = down ? `down: ${reason} · ${consecFails} fails` : `errored: ${reason}`;
  await api("/register", { session: SESSION, project: PROJ, status }).catch(() => {});
  const hint = reason === "exhausted" ? " — needs `trantor swap`"
    : reason === "auth" ? " — check credentials"
    : reason === "missing-cli" ? " — CLI not on PATH" : "";
  const text = down
    ? `🛑 ${SESSION} DOWN — ${consecFails} consecutive failures (${reason}, exit ${exit})${hint}`
    : `⚠️ ${SESSION} turn FAILED (${trigger}, exit ${exit} · ${reason})${hint}`;
  await api("/send", { from: SESSION, to: "all", text, project: PROJ }).catch(() => {});
  cmuxStatus(down ? "down" : "error", "#ef6a6a", "alert"); cmuxLog(`turn failed: ${reason} (exit ${exit})`, "error");
  log(`\x1b[31mreported failure to bus: ${reason} (exit ${exit})\x1b[0m`);
}

async function reportHealthy() {
  if (consecFails === 0) return;        // already healthy — don't spam
  consecFails = 0;
  await api("/register", { session: SESSION, project: PROJ, status: `active in ${PROJ}` }).catch(() => {});
  await api("/send", { from: SESSION, to: "all", text: `✅ ${SESSION} recovered`, project: PROJ }).catch(() => {});
  cmuxStatus("ok", "#14b8a6", "check");
}

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
  cmuxStatus("building", "#4a90d9", "hammer");
  // inherit stdio so the window shows the agent working live; also capture for sid-parsing.
  // Tee stderr to ERRF (still shown live in the window) so a failed turn can be classified.
  try { appendFileSync(ERRF, "", { flag: "w" }); } catch {}
  // pipefail: without it the sid-capture `| tee` makes a FAILED turn exit 0 (tee's status),
  // so the failure reporter never fires and a dead seat heartbeats green on the bus.
  const inner = cli.sid ? `${cmd} | tee /dev/stderr` : cmd;
  const r = spawnSync("/bin/bash", ["-c", `set -o pipefail; { ${inner} ; } 2> >(tee -a ${ERRF} >&2)`], {
    cwd: DIR, encoding: "utf8", stdio: cli.sid ? ["ignore", "pipe", "inherit"] : "inherit",
    env: { ...process.env, RELAY_URL: HUB, RELAY_AGENT: AGENT, RELAY_PROJECT: PROJ },
    maxBuffer: 16 * 1024 * 1024,
  });
  try { lastErrText = readFileSync(ERRF, "utf8").slice(-4000); } catch { lastErrText = ""; }
  if (cli.sid && r.stdout) { const m = r.stdout.match(cli.sid); if (m) sid = m[1]; }
  telemetry({ ts: Date.now(), agent: AGENT, project: PROJ, turn: TURN, trigger, model: MODEL || "default", duration_ms: Date.now() - t0, exit: r.status });
  log(`turn ended (exit ${r.status}, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  if (r.status === 0) cmuxStatus("idle", "#8a94a6", "robot");   // finished this turn, waiting for the next
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
  const ec0 = runTurn(KICKOFF + LESSONS, true, "kickoff");
  if (ec0) await reportFailure(ec0, "kickoff");   // a failed kickoff = the "fired up, died, nobody knew" case
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
    await loadLessons();
    const ec = runTurn(prompt + LESSONS, false, direct.length ? "direct message" : "@mention");
    if (ec) await reportFailure(ec, "message"); else await reportHealthy();
    log("parked — waiting for the next message");
  }
})();

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
import { readFileSync, writeFileSync, unlinkSync, existsSync, appendFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { resolveProject, resolveHub, withEnvFiles } from "../lib/project.mjs";
import { loadOrCreate } from "../lib/identity.mjs";
import { signedHeaders } from "../lib/signed-fetch.mjs";
import { ensureEnrolled } from "../lib/enroll.mjs";

const AGENT = process.argv[2];
const DIR = process.argv[3] || process.cwd();
// Crew agents MUST share the orchestrator's project key (one repo = one lane).
// RELAY_PROJECT is inherited from crew.sh (the host's resolved key); else fall
// back to the git-repo-root basename — never a loose dir basename that could
// fork the host's "builtbetter.ai" into a separate "builtbetter" lane.
const PROJ = process.env.RELAY_PROJECT || resolveProject(DIR);
// RUNNER_SESSION override: an orchestrator seat (bin/orchestrate.mjs) runs the same CLI as a crew
// seat but must live on the bus under its own name (claude-orch:proj), or it would collide with a
// plain claude crew seat on the same project.
const SESSION = process.env.RUNNER_SESSION || `${AGENT}:${PROJ}`;
// One keypair per seat, so `deepseek:crebral` and `deepseek:trantor` are genuinely different
// identities on the bus rather than one shared string label.
const identity = loadOrCreate(SESSION, "agent");
if (!AGENT) { console.error("usage: crew-runner.mjs <agent> [project-dir]"); process.exit(1); }

// Per-project routing (TDD §12.1): a seat MUST reach the same hub as the project it serves. Reading
// only the global default sent seats on a migrated project to the local hub while their orchestrator
// talked to the remote one — the crew would look alive and record onto a different board entirely.
function hubUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL;
  try { return resolveHub(PROJ); } catch {}
  return "http://127.0.0.1:4477";
}
const HUB = hubUrl();
// On an authenticated hub a freshly-created seat keypair is an UNKNOWN identity, so every call 401s
// and the seat goes silently quiet (we fail open by design). Self-enrol first, using the operator's
// owner key to mint a short-lived project-scoped invite the seat immediately spends.
const enrolment = await ensureEnrolled(HUB, identity, PROJ);
if (!enrolment.ok && enrolment.reason !== "hub-unreachable") {
  console.log(`\x1b[33m[runner]\x1b[0m not enrolled on ${HUB} (${enrolment.reason}) — cards may not record`);
}
process.on("uncaughtException", (e) => { console.log(`\x1b[31m[runner] UNCAUGHT: ${e?.stack || e}\x1b[0m`); });
process.on("unhandledRejection", (e) => { console.log(`\x1b[31m[runner] UNHANDLED REJECTION: ${e?.stack || e}\x1b[0m`); });
const log = (s) => console.log(`\x1b[38;5;43m[runner]\x1b[0m ${s}`);
const LOGDIR = join(homedir(), ".agent-bus", "logs");
import { mkdirSync } from "node:fs";
try { mkdirSync(LOGDIR, { recursive: true }); } catch {}
let TURN = 0;
const telemetry = (rec) => { try { appendFileSync(join(LOGDIR, `${AGENT}-${PROJ}.jsonl`), JSON.stringify(rec) + "\n"); } catch {} };
// Boot line records the HUB this runner bound to — the 2026-08-14 split-brain took an hour to
// diagnose because nothing on disk said which hub a seat was talking to.
telemetry({ ts: Date.now(), agent: AGENT, project: PROJ, boot: true, hub: HUB });
// A seat can open a terminal window on a machine whose owner never asked for one and does not know
// what they are looking at. "◤ CLAUDE ◢ trantor crew · fleet" tells that person nothing: not what
// started, not what it will do, not how to stop it. RUNNER_TITLE names it in full and RUNNER_ABOUT
// explains it, printed once on the first turn.
const TITLE = process.env.RUNNER_TITLE || `trantor crew · ${PROJ}`;
const ABOUT = process.env.RUNNER_ABOUT || "";
let aboutShown = false;
const banner = (trigger) => {
  console.log(`\x1b[2J\x1b[H\x1b[48;5;236m\x1b[38;5;43m  ◤ ${AGENT.toUpperCase()} ◢  ${TITLE} · turn ${TURN} · ${trigger}${MODEL ? ` · ${MODEL}` : ""}  \x1b[0m\n`);
  if (ABOUT && !aboutShown) { aboutShown = true; console.log(`\x1b[2m${ABOUT}\x1b[0m\n`); }
};

async function api(path, body) {
  const opts = body
    ? { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify(body) }
    : { headers: { connection: "close" } };   // fresh socket per call — long-polls on stale keep-alive sockets reset
  // Sign as THIS seat. Unsigned calls are 401 on an enforce hub, and because the runner fails open
  // that shows up as a seat that quietly records nothing rather than one that errors.
  const url = HUB + path;
  const sig = signedHeaders(identity, url, opts);
  // HARD DEADLINE on every call (2026-08-01, crebral-health kimi seat): a long-poll whose socket
  // dies silently (idle NAT/tailscale reset, no RST delivered) otherwise hangs fetch FOREVER —
  // the runner sat "parked" with zero connections and zero retries while its crew was rebuilt
  // around it. Deadline = the poll's own wait window + slack, so a healthy long-poll never trips
  // it and a dead one surfaces as a catchable error that the main loop retries in 5s.
  const waitS = Number((path.match(/[?&]wait=(\d+)/) || [])[1] || 0);
  const r = await fetch(url, { ...opts, headers: { ...opts.headers, ...sig }, signal: AbortSignal.timeout((waitS + 30) * 1000) });
  return r.json();
}

// ---- cmux sidebar integration ----
// When this runner is inside a cmux surface (CMUX_SURFACE_ID is auto-set there), push its live state into
// cmux's sidebar for THIS seat. An inside process is allowed by cmux's default cmuxOnly socket mode — no
// allowAll needed. Fail-silent + short timeout; must never block or slow a turn.
const CMUX_BIN = process.env.CMUX_BIN
  || (existsSync("/Applications/cmux.app/Contents/Resources/bin/cmux") ? "/Applications/cmux.app/Contents/Resources/bin/cmux" : "cmux");
const inCmux = () => !!process.env.CMUX_SURFACE_ID;
// Brand colors — the SAME hexes the desktop app's Avatar.tsx uses, so a seat is the same color in
// the cmux sidebar and the Trantor app. cmux status icons are a fixed named set (no images), so an
// actual LLM logo in the pill is not possible — brand COLOR + the agent's name in the label is the
// closest cmux allows.
const BRAND_HEX = { claude: "#D97757", codex: "#e8e8ee", openai: "#e8e8ee", deepseek: "#5786FE",
  dsh: "#4D6BFE",
  kimi: "#8b8bf5", moonshot: "#8b8bf5", glm: "#5ea0f5", zai: "#5ea0f5", gemini: "#8E75B2", openrouter: "#94A3B8" };
function cmuxStatus(value, color, icon = "robot", opts = {}) {
  if (!inCmux()) return;
  // Label with the REAL seat identity, not a literal. This was hardcoded to "trantor", so every seat
  // in every project reported under one name — four different agents (and their duplicates) rendered
  // identically in the sidebar, which is why a runner leak looked like mystery sessions instead of
  // obvious duplicates. Note this is the DISPLAY path; two previous fixes to the crossed-label
  // symptom both landed on the *bus* identity and never touched this line.
  // Pill = "<agent> · <state>" in the agent's BRAND color (alerts keep their alarm color — a red
  // error must read as red at a glance); errors sort first via --priority.
  const col = opts.alert ? color : (BRAND_HEX[AGENT.toLowerCase()] || color);
  try { spawnSync(CMUX_BIN, ["set-status", SESSION, `${AGENT} · ${value}`, "--color", col, "--icon", icon, "--priority", String(opts.priority ?? 0)], { stdio: "ignore", timeout: 1500, env: { ...process.env, CMUX_QUIET: "1" } }); } catch {}
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
  // DeepSeek Harness. Every turn is a FRESH session — headless has no resume yet — so the seat
  // relies on the wake prompt + the board (via the relay tools its profile mounts) rather than
  // conversation memory. `trantor connect` builds the ~/.dsh/profiles/trantor composition: their
  // CC-hooks bridge running OUR hooks + their MCP client running our relay server. No model flag:
  // headless takes only the task; the model is profile config.
  dsh:      { first: `dsh --profile trantor "$(cat {P})" < /dev/null`,
              next:  `dsh --profile trantor "$(cat {P})" < /dev/null`, mflag: "", env: join(homedir(), ".token-scrooge", ".env") },
};
// BYOM: any agent label that isn't a known native CLI is treated as an opencode-driven provider
// seat (opencode is the universal adapter). This is what lets a BROUGHT provider — `trantor up
// <label>:<provider>` for any opencode vendor the user configured — run with no per-provider code
// here; its model id arrives pre-qualified (`<provider>/<model>`) as CREW_MODEL.
const NATIVE = new Set(["codex", "gemini", "kimi", "claude", "dsh"]);
const cli = CLI[AGENT] || (NATIVE.has(AGENT) ? null : CLI.opencode);
if (!cli) { console.error(`unknown agent '${AGENT}' (native: ${[...NATIVE].join(", ")}; any other name = an opencode provider seat)`); process.exit(1); }
if (!CLI[AGENT]) log(`'${AGENT}' is not a built-in seat — running it as an opencode provider (BYOM)`);

// RUNNER_RULES / RUNNER_KICKOFF env overrides: the runner is also the substrate for non-crew
// always-on seats (the fleet DUTY agent, bin/duty.mjs) whose doctrine is not "work your card".
const RULES = process.env.RUNNER_RULES || `Rules: you are ${SESSION} on the trantor crew. Before starting a card, query the board for related PAST cards and lessons (relay_board — 1900+ cards of tribal knowledge; prior work may already answer half of it). Work your assigned file(s), report on the bus (relay_send, <280 chars), move your Kanban card as you go with a NOTE saying what you did (doing -> testing -> done; in 'testing' run YOUR OWN test file — never the full npm test, suites collide across seats — plus \`node bin/slop-gate.mjs\` when the repo has one: it lints ONLY your changed files against the anti-slop rules, and a card must not reach done with slop-gate failing; use 'failed' + a report if anything breaks). If you need something from another session, message THAT SESSION (relay_peers to find its id, relay_send to reach it) — never ask the human to pass it along; carrying messages between agents is the job this bus exists to remove. When your work for THIS message is finished, END YOUR TURN — do NOT park, do NOT loop relay_wait; the runner waits for you and will wake you with the next message.`;

// ---- the pulse (Scape's Lloyd/Argus loop, Trantor-shaped) --------------------
// A message-driven seat is DEAF between messages. An orchestrator seat with a mission needs a
// metronome: RUNNER_PULSE_MS re-runs its mission note on a cadence even when the bus is silent.
// The pulse prompt is deliberately almost verbatim the one that works in the wild: re-read the
// note, continue, check your children, record. Boot discipline rides with it — an empty mission
// means STAND BY, never invented work.
const PULSE_MS = Math.max(0, Number(process.env.RUNNER_PULSE_MS || 0));
const MISSION_FILE = process.env.RUNNER_MISSION_FILE || "MISSION.md";
const PULSE_PROMPT = `[pulse] Re-read your mission note (${MISSION_FILE} in your working directory) and continue your mission. Check on your children and your board, unblock what is stuck, and record what you did. If the mission note is missing, empty, or has no actionable mission, reply ONLY that you are standing by and end your turn — do NOT invent work, create files, or spawn anything.`;

// ---- failure visibility ----------------------------------------------------
// A turn's CLI can fail (credits exhausted, auth, crash) and the runner would just
// re-park — staying green on the bus, telling the orchestrator NOTHING. These surface
// every non-zero turn to the bus in real time so the orchestrator (and `trantor swap`)
// can react, and flip presence to errored/down.
let consecFails = 0;
let lastErrText = "";
const ERRF = join(homedir(), ".agent-bus", `err-${AGENT}-${PROJ}.txt`);

// ---- undelivered wake messages (the runner owns delivery, not the hub) ----
// The hub hands a message out exactly ONCE: the poll cursor advances the instant we read it, and
// nothing ever re-fires. So a turn that died — API outage, quota wall, crashed CLI — used to take
// its wake message down with it, and an escalation addressed to this seat was gone forever with
// no trace anywhere. The queue below makes delivery the runner's job: a message is not consumed
// until a turn actually exits 0. It survives a runner restart on disk, retries on its own backoff
// so a silent bus still gets it through, and says how many are outstanding every time it reports.
const PENDF = join(homedir(), ".agent-bus", `pending-${AGENT}-${PROJ}.json`);
// A cap, so a long outage cannot grow the queue without bound. Overflow drops the OLDEST and says
// so on the bus — a silent drop is the exact failure this whole mechanism exists to end.
const PENDING_MAX = 50;
// Backoff between redelivery attempts. Starts fast (a blip clears in 30s) and lands at 15 minutes,
// which is the cadence for "this seat is properly down" rather than a retry storm against a hub
// that is already refusing us.
// TRANTOR_RETRY_MS (comma-separated ms) shortens the ladder so the redelivery drill can exercise
// a real backoff in seconds instead of waiting out the production one.
const RETRY_MS = (() => {
  // Guard the UNSET case explicitly: "".split(",") is [""], Number("") is 0, and a >=0 filter
  // accepted it — so every production runner got a ZERO backoff and a failing seat became a
  // retry storm (observed live: 43 crashed turns in ~3 minutes on the first dsh seat). The
  // hermetic drill never caught it because it always SET the override.
  const raw = process.env.TRANTOR_RETRY_MS;
  const custom = raw ? raw.split(",").map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
  return custom.length ? custom : [30e3, 60e3, 120e3, 300e3, 900e3];
})();
function savePending(wake, bcast) {
  try {
    if (!wake.length && !bcast.length) { try { unlinkSync(PENDF); } catch {} return; }
    writeFileSync(PENDF, JSON.stringify({ agent: AGENT, project: PROJ, ts: Date.now(), wake, bcast }));
  } catch {}
}
function loadPending() {
  try {
    const j = JSON.parse(readFileSync(PENDF, "utf8"));
    return { wake: Array.isArray(j.wake) ? j.wake : [], bcast: Array.isArray(j.bcast) ? j.bcast : [] };
  } catch { return { wake: [], bcast: [] }; }
}

function classifyFailure(exit, errText) {
  const t = (errText || "").toLowerCase();
  if (exit === 127) return "missing-cli";
  // "reached your … limit" / "usage limit" catch the subscription CLIs (Claude's "You've reached
  // your Fable 5 limit"), which say nothing about quota or credits and would otherwise read as a crash.
  if (/quota|insufficient|credit|balance|payment required|402|429|too many requests|rate.?limit|exceeded your|reached your [^.\n]*limit|usage limit|out of (credit|quota)/.test(t)) return "exhausted";
  if (/unauthor|401|invalid[ _-]?api[ _-]?key|forbidden|403|token expired|expired/.test(t)) return "auth";
  return "crashed";
}

async function reportFailure(exit, trigger, undelivered = 0) {
  consecFails++;
  const reason = classifyFailure(exit, lastErrText);
  const down = consecFails >= 2;
  const status = down ? `down: ${reason} · ${consecFails} fails` : `errored: ${reason}`;
  await api("/register", { session: SESSION, project: PROJ, status, llm: AGENT, model: MODEL }).catch(() => {});
  const hint = reason === "exhausted" ? " — needs `trantor swap`"
    : reason === "auth" ? " — check credentials"
    : reason === "missing-cli" ? " — CLI not on PATH" : "";
  // The count of messages this seat is HOLDING is the operator-actionable half of a failure: a
  // crashed pulse costs nothing, a crashed turn sitting on three escalations is someone waiting.
  const held = undelivered ? ` · holding ${undelivered} undelivered message${undelivered > 1 ? "s" : ""} (will retry)` : "";
  const text = down
    ? `🛑 ${SESSION} DOWN — ${consecFails} consecutive failures (${reason}, exit ${exit})${hint}${held}`
    : `⚠️ ${SESSION} turn FAILED (${trigger}, exit ${exit} · ${reason})${hint}${held}`;
  await api("/send", { from: SESSION, to: "all", text, project: PROJ }).catch(() => {});
  cmuxStatus(down ? "down" : "error", "#ef6a6a", "alert", { alert: true, priority: 90 }); cmuxLog(`turn failed: ${reason} (exit ${exit})`, "error");
  log(`\x1b[31mreported failure to bus: ${reason} (exit ${exit})\x1b[0m`);
}

// ---- telling the ASSIGNER, mechanically ------------------------------------
// A seat used to finish its contract and say nothing. Completion lived only in the RULES prompt
// ("report on the bus"), so a cheap model that did the work and ended its turn left the
// orchestrator blind, and nothing watched for the omission. Failures were mechanical but went to
// "all", and a plain broadcast does not wake anyone (see the wake policy in the main loop). From
// the orchestrator's seat a finished crew and a crew that never started looked identical.
//
// So: whoever sent the message that woke this seat gets told DIRECTLY what became of it. Direct
// messages wake; that is the whole difference. Kept short, like every other bus line.
async function notifyAssigners(pairs, text) {
  const seen = new Set();
  for (const { from: f, id } of pairs) {
    // `hub:*` senders are the hub's own pseudo-ids (hub:duty, the overseer), not sessions: nothing
    // is ever on the other end reading. Acking one goes undelivered, escalates back to duty, and
    // wakes this seat again — every overseer-woken turn loops. Found by the duty agent within
    // minutes of 0.17.85 shipping, which is the bus doing its job.
    if (!f || f === "all" || f === SESSION || f.startsWith("hub:") || seen.has(f)) continue;
    seen.add(f);
    // `re` threads this outcome to the exact contract it answers, so the sender's ledger closes the
    // right one instead of guessing from timing.
    await api("/send", { from: SESSION, to: f, text: text.slice(0, 280), project: PROJ, ...(id ? { re: id } : {}) }).catch(() => {});
  }
  if (seen.size) log(`reported outcome to ${[...seen].join(", ")}`);
}

async function reportHealthy() {
  if (consecFails === 0) return;        // already healthy — don't spam
  consecFails = 0;
  await api("/register", { session: SESSION, project: PROJ, status: `active in ${PROJ}`, llm: AGENT, model: MODEL }).catch(() => {});
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
  // PRECEDENCE, and it is easy to get backwards — this is the second time.
  // Each file is PREPENDED, so the one prepended LAST runs FIRST, and in shell the file that runs
  // LAST wins. To make ~/.agent-bus/.env (the CREW layer) win it must be prepended FIRST, i.e.
  // iterate the list in its written order — highest priority first. A `.reverse()` here inverted it
  // and handed every seat Scrooge's key instead of the crew's, which is why one key was paying for
  // both and no provider bill could tell them apart. `.reverse()` also mutated the array in place.
  // Verified by test-crew-env.mjs, which runs the real shell rather than reading this comment.
  // Priority order: the CREW layer first, the agent's own fallback (Scrooge's .env) after it.
  const envs = [join(homedir(), ".agent-bus", ".env"), cli.env].filter(f => f && existsSync(f));
  cmd = withEnvFiles(cmd, envs);
  log(`turn starting (${isFirst ? "fresh session" : "resume"})${MODEL ? ` · model=${MODEL}` : ""}`);
  cmuxStatus("building", "#4a90d9", "hammer", { priority: 50 });
  // inherit stdio so the window shows the agent working live; also capture for sid-parsing.
  // Tee stderr to ERRF (still shown live in the window) so a failed turn can be classified.
  try { appendFileSync(ERRF, "", { flag: "w" }); } catch {}
  // pipefail: without it the sid-capture `| tee` makes a FAILED turn exit 0 (tee's status),
  // so the failure reporter never fires and a dead seat heartbeats green on the bus.
  // A CLI's own explanation for quitting often goes to STDOUT, not stderr — Claude's usage-limit
  // notice is the case that bit us: ERRF stayed empty, so a plainly exhausted seat was reported as
  // `crashed` and nobody knew to swap it. sid seats already fold stdout into the ERRF stream via
  // `tee /dev/stderr`; the rest now tee straight into ERRF. A real pipeline (not a process
  // substitution) so bash waits for tee to flush before we read the file back.
  const inner = cli.sid ? `${cmd} | tee /dev/stderr` : `${cmd} | tee -a ${ERRF}`;
  const r = spawnSync("/bin/bash", ["-c", `set -o pipefail; { ${inner} ; } 2> >(tee -a ${ERRF} >&2)`], {
    cwd: DIR, encoding: "utf8", stdio: cli.sid ? ["ignore", "pipe", "inherit"] : "inherit",
    env: { ...process.env, RELAY_URL: HUB, RELAY_AGENT: AGENT, RELAY_PROJECT: PROJ,
      // A RUNNER-MANAGED SEAT MUST NEVER HAND ITSELF A BATON.
      //
      // The handoff machinery exists for an INTERACTIVE session: near its context limit it writes a
      // handoff and opens a fresh window to carry on. A seat has no use for that — the runner is its
      // lifecycle manager and wakes it per event — so the spawn just leaks an unmanaged interactive
      // session into a window nobody asked for.
      //
      // Observed on the duty seat: handoff records at 17:24 and 18:59 on 2026-08-24, and two stray
      // `claude` processes in ~/.agent-bus/trantor-duty started at 17:24:57 and 18:59:50, still
      // sitting there days later. To the operator that reads as "why are there two duty agents".
      TRANTOR_NO_HANDOFF_SPAWN: "1", TRANTOR_NO_BATON_SPAWN: "1" },
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
  `You just joined (your arrival was already announced on the bus). 1) relay_inbox — if a contract for you is already waiting, do it now per the Rules. 2) End your turn.\n\n${RULES}`;

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
  await api("/register", { session: SESSION, project: PROJ, status: "crew member booting", llm: AGENT, model: MODEL }).catch(() => {});
  // Announce runner-side, signed as THIS seat. Asking the seat to announce itself sent glm's hello
  // out under deepseek's identity whenever opencode seats shared one MCP daemon (lesson on the bus,
  // 2026-07-29): the runner process is per-seat by construction, so its signature cannot be borrowed.
  try {
    const { sfetchJson } = await import("../lib/signed-fetch.mjs");
    const { loadOrCreate } = await import("../lib/identity.mjs");
    await sfetchJson(`${HUB}/send`, {
      identity: loadOrCreate(SESSION, "agent"),
      payload: { from: SESSION, to: "all", project: PROJ, text: `${AGENT} reporting — ready for a contract${MODEL ? ` (${MODEL})` : ""}` },
      signal: AbortSignal.timeout(2500),
    });
  } catch {}

  // Wake messages this seat has PULLED off the bus but not yet worked successfully, plus the
  // broadcasts batched behind them. Restored from disk first: a runner that was killed mid-turn
  // (or a machine that rebooted) still owes those messages, and the hub will never send them again.
  const restored = loadPending();
  let pendingWake = restored.wake;
  let pendingBcast = restored.bcast;
  let retryAt = 0;            // 0 = deliver at the next opportunity
  let deliveryFails = 0;      // consecutive failed attempts at the SAME pending batch
  if (pendingWake.length) log(`\x1b[33m${pendingWake.length} message(s) survived from a previous run — redelivering\x1b[0m`);

  const ec0 = runTurn(KICKOFF + LESSONS, true, "kickoff");
  if (ec0) await reportFailure(ec0, "kickoff", pendingWake.length);   // a failed kickoff = the "fired up, died, nobody knew" case
  let lastTurnAt = Date.now();
  if (PULSE_MS) log(`pulse armed — mission re-read every ${Math.round(PULSE_MS / 1000)}s (${MISSION_FILE})`);
  log(`parked — long-polling the bus as ${SESSION} (free; this poll is also the heartbeat)`);

  while (true) {
    // pulse first: a due mission beat runs even on a silent bus. Measured from the END of the
    // last turn, so a long turn doesn't stack an immediate pulse on top of itself.
    if (PULSE_MS && Date.now() - lastTurnAt >= PULSE_MS) {
      const ecp = runTurn(PULSE_PROMPT + "\n\n" + RULES + LESSONS, false, "pulse");
      if (ecp) await reportFailure(ecp, "pulse"); else await reportHealthy();
      lastTurnAt = Date.now();
      log("parked — waiting for the next message or pulse");
      continue;
    }
    // A due REDELIVERY runs before we go back to waiting — during an outage the bus is silent by
    // definition, so the retry timer is the only thing that will ever move these messages.
    if (pendingWake.length && Date.now() >= retryAt) { await deliverWake(); continue; }
    // cap the long-poll hold so neither a due pulse nor a due redelivery waits out a silent 280s window
    const due = [];
    if (PULSE_MS) due.push(PULSE_MS - (Date.now() - lastTurnAt));
    if (pendingWake.length) due.push(retryAt - Date.now());
    const holdS = due.length
      ? Math.max(5, Math.min(280, Math.ceil(Math.min(...due) / 1000)))
      : 280;
    let msgs = [];
    try {
      const r = await api(`/poll?session=${encodeURIComponent(SESSION)}&since=${cursor}&wait=${holdS}`);
      msgs = r.messages || []; cursor = r.cursor ?? cursor;
    } catch (e) {
      // Deadline-abort on the LONG-POLL is not an outage — it means the hold expired with no hub
      // response (stalled event loop, napped machine, dead socket). Reconnect immediately and say
      // so calmly; reserve the scary "hub unreachable" + 5s backoff for real connection failures.
      const expired = e && (e.name === "TimeoutError" || /abort/i.test(String(e.message)));
      log(expired ? `long-poll hold expired with no hub response — reconnecting` : `hub unreachable (${e.message}) — retrying in 5s`);
      await new Promise(s => setTimeout(s, expired ? 250 : 5000)); continue;
    }
    if (!msgs.length) continue;                       // heartbeat tick, nothing for us
    // never wake on your own broadcasts: a claude seat's report contains "claude:" and matched the
    // @mention filter, buying one echo turn per report (seen live on the first pulsed orchestrator)
    msgs = msgs.filter(m => m.from !== SESSION);
    const direct = msgs.filter(m => m.to === SESSION);
    const mentions = msgs.filter(m => m.to === "all" && (m.text.includes(`@${AGENT}`) || m.text.toLowerCase().includes(`${AGENT}:`)));
    const bcast = msgs.filter(m => m.to === "all" && !mentions.includes(m));
    pendingBcast.push(...bcast);                      // wake-policy: plain broadcasts batch, they don't wake
    const wake = [...direct, ...mentions];
    if (!wake.length) { if (bcast.length) { savePending(pendingWake, pendingBcast); log(`${bcast.length} broadcast(s) batched (no wake) — ${pendingBcast.length} pending`); } continue; }
    // Queue BEFORE running the turn, and persist immediately. Everything between here and a clean
    // exit 0 — the CLI dying, the machine losing power — now leaves a record of what this seat owes.
    pendingWake.push(...wake);
    if (pendingWake.length > PENDING_MAX) {
      const dropped = pendingWake.splice(0, pendingWake.length - PENDING_MAX);
      log(`\x1b[31mundelivered queue overflowed — dropped ${dropped.length} oldest message(s)\x1b[0m`);
      await api("/send", { from: SESSION, to: "all", project: PROJ,
        text: `⚠️ ${SESSION} dropped ${dropped.length} undelivered message(s) — queue hit its ${PENDING_MAX} cap during a failure streak` }).catch(() => {});
    }
    savePending(pendingWake, pendingBcast);
    // Respect an active backoff: a new message during an outage joins the batch, it does not
    // reset the clock and hammer a CLI that is already failing.
    if (Date.now() < retryAt) { log(`queued — ${pendingWake.length} undelivered, next attempt in ${Math.max(0, Math.round((retryAt - Date.now()) / 1000))}s`); continue; }
    await deliverWake();
    log("parked — waiting for the next message");
  }

  // Run the pending batch. The messages are cleared ONLY on exit 0; any other outcome leaves them
  // queued, on disk, with a backoff — which is the whole point of the change.
  async function deliverWake() {
    const wake = pendingWake;
    const ctx = pendingBcast.length ? `\nFYI broadcasts since your last turn (context only):\n${pendingBcast.map(m => `[${m.from} -> all]: ${m.text}`).join("\n")}\n` : "";
    const lines = wake.map(m => `[${m.from}${m.to === "all" ? " -> all (mentions you)" : ""}]: ${m.text}`).join("\n");
    // Say plainly that this is a second look. Without it the model re-reads an old escalation as
    // brand new and can redo work it already half-did before the turn died.
    const again = deliveryFails
      ? `\n(REDELIVERY, attempt ${deliveryFails + 1} — an earlier turn failed before acting on ${wake.length > 1 ? "these" : "this"}. Check what you already did before repeating it.)\n`
      : "";
    const prompt = `NEW BUS MESSAGE${wake.length > 1 ? "S" : ""} for you:\n${lines}\n${ctx}${again}\nAct on what's addressed to you, then end your turn.\n\n${RULES}`;
    await loadLessons();
    const trigger = wake.some(m => m.to === SESSION) ? "direct message" : "@mention";
    // Who is owed an answer, captured BEFORE the turn: pendingWake is cleared on success.
    const assigners = [];
    for (const m of wake) if (m.from && !assigners.some(a => a.from === m.from)) assigners.push({ from: m.from, id: m.id });
    const asked = String(wake[0]?.text || "").replace(/\s+/g, " ").trim().slice(0, 90);
    const tStart = Date.now();
    const ec = runTurn(prompt + LESSONS, false, deliveryFails ? `${trigger} (redelivery)` : trigger);
    const secs = Math.round((Date.now() - tStart) / 1000);
    if (ec) {
      deliveryFails++;
      const wait = RETRY_MS[Math.min(deliveryFails - 1, RETRY_MS.length - 1)];
      retryAt = Date.now() + wait;
      savePending(pendingWake, pendingBcast);
      await reportFailure(ec, "message", pendingWake.length);
      // The room hears the broadcast above; the one who is actually blocked hears it directly.
      await notifyAssigners(assigners,
        `⚠️ your contract FAILED on ${SESSION} (exit ${ec}, ${classifyFailure(ec, lastErrText)}) · retrying in ${Math.round(wait / 1000)}s · asked: "${asked}"`);
      log(`\x1b[31m${pendingWake.length} message(s) still UNDELIVERED — next attempt in ${Math.round(wait / 1000)}s\x1b[0m`);
    } else {
      pendingWake = []; pendingBcast = []; deliveryFails = 0; retryAt = 0;
      savePending([], []);
      await reportHealthy();
      await notifyAssigners(assigners,
        `✅ done on ${SESSION} (exit 0, ${secs}s) · asked: "${asked}" · check the board card and the files for what changed`);
    }
    lastTurnAt = Date.now();
  }
})();

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
import { execSync, spawnSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { resolveProject, resolveHub, withEnvFiles, hostId } from "../lib/project.mjs";
import { loadOrCreate } from "../lib/identity.mjs";
import { signedHeaders } from "../lib/signed-fetch.mjs";
import { ensureEnrolled } from "../lib/enroll.mjs";
import { redactKeys } from "../lib/redact.mjs";
import {
  AUTH_MARKER_RE, classifyFailure, looksLikeAuthDeath,
  verdictFor,
  readPromptText, stripPromptEcho,
} from "../lib/classify-failure.mjs";
import { capWake, capBcast, pickLessons, composePrompt } from "./crew-payload.mjs";

const AGENT = process.argv[2];
const DIR = process.argv[3] || process.cwd();
// Crew agents MUST share the orchestrator's project key (one repo = one lane).
// RELAY_PROJECT is inherited from crew.sh (the host's resolved key); else fall
// back to the git-repo-root basename — never a loose dir basename that could
// fork the host's "builtbetter.ai" into a separate "builtbetter" lane.
const PROJ = process.env.RELAY_PROJECT || resolveProject(DIR);

function safePathSegment(s) {
  return String(s).replace(/\.{2,}/g, "_").replace(/[^A-Za-z0-9_.-]/g, "_");
}

function gitOut(args, cwd = DIR) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 8000 });
  return r.status === 0 ? String(r.stdout || "").trim() : "";
}

function ensureSeatWorktree(sourceDir) {
  if (process.env.TRANTOR_NO_WORKTREE === "1") return sourceDir;
  const root = gitOut(["-C", sourceDir, "rev-parse", "--show-toplevel"], sourceDir);
  if (!root) return sourceDir;

  spawnSync("git", ["-C", root, "worktree", "prune"], { stdio: "ignore", timeout: 8000 });
  const seatDir = join(homedir(), ".agent-bus", "worktrees", safePathSegment(PROJ), safePathSegment(AGENT));
  const branch = `seat/${AGENT}`;
  if (existsSync(seatDir)) {
    const ok = gitOut(["-C", seatDir, "rev-parse", "--is-inside-work-tree"], seatDir) === "true";
    if (ok) {
      // #5403: a worktree created once builds against THAT day's main forever — every wave since
      // has needed a hand fast-forward. Refresh only when it is CLEAN: a dirty tree is a seat's
      // unintegrated work and a diverged branch is a decision, and refreshing must never eat
      // either. Failure to refresh is loud but non-fatal: stale beats broken.
      const dirty = gitOut(["-C", seatDir, "status", "--porcelain"], seatDir);
      if (dirty === "") {
        const head = gitOut(["-C", root, "rev-parse", "HEAD"], root);
        const ff = head && spawnSync("git", ["-C", seatDir, "merge", "--ff-only", head], { stdio: "ignore", timeout: 15000 });
        if (ff && ff.status === 0) console.log(`\x1b[2m[runner]\x1b[0m ${branch} worktree refreshed to ${head.slice(0, 7)}`);
        else console.log(`\x1b[33m[runner]\x1b[0m ${branch} worktree diverged from main HEAD — left as-is (integrate or reset it)`);
      } else {
        console.log(`\x1b[33m[runner]\x1b[0m ${branch} worktree has uncommitted work — not refreshed`);
      }
      return seatDir;
    }
    console.log(`\x1b[33m[runner]\x1b[0m worktree path exists but is not a git worktree: ${seatDir} — using ${sourceDir}`);
    return sourceDir;
  }

  try { mkdirSync(join(homedir(), ".agent-bus", "worktrees", safePathSegment(PROJ)), { recursive: true }); } catch {}

  // Fast-forward the base branch before branching: the worktree should build
  // against the latest main, not a stale checkout. (#5403)
  const base = gitOut(["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], root);
  if (base) {
    const remote = gitOut(["-C", root, "rev-parse", "--abbrev-ref", `${base}@{upstream}`], root);
    if (remote) {
      const ff = spawnSync("git", ["-C", root, "merge", "--ff-only", remote], { stdio: "ignore", timeout: 15000 });
      if (ff && ff.status === 0) console.log(`\x1b[2m[runner]\x1b[0m ${base} fast-forwarded to ${remote}`);
    }
  }

  const r = spawnSync("git", ["-C", root, "worktree", "add", "--no-track", "-B", branch, seatDir, "HEAD"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000,
  });
  if (r.status === 0) {
    // Persist the base branch so the Review lens can name the real base instead
    // of guessing via merge-base. Stale metadata is unset, not trusted. (#5403)
    if (base) {
      spawnSync("git", ["-C", seatDir, "config", `branch.${branch}.base`, base], { stdio: "ignore", timeout: 5000 });
    }
    // Set push.autoSetupRemote so a plain git push creates and sets upstream on
    // first push (git >= 2.37, older clients ignore it). (#5403)
    const pushAuto = gitOut(["-C", seatDir, "config", "--get", "push.autoSetupRemote"], seatDir);
    if (!pushAuto) {
      spawnSync("git", ["-C", seatDir, "config", "push.autoSetupRemote", "true"], { stdio: "ignore", timeout: 5000 });
    }
    return seatDir;
  }
  console.log(`\x1b[33m[runner]\x1b[0m could not create ${branch} worktree — using ${sourceDir}`);
  return sourceDir;
}

const TURN_DIR = ensureSeatWorktree(DIR);
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
const log = (s) => console.log(`\x1b[38;5;43m[runner]\x1b[0m ${redactKeys(String(s))}`);
const LOGDIR = join(homedir(), ".agent-bus", "logs");
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
// herdr drops a pane's agent registration when the process inside it exits — and a seat's CLI
// exits at the END OF EVERY TURN. Reporting once when the pane is created is therefore not enough:
// the seat vanishes from `herdr agent list` after its first turn, `herdr agent attach` starts
// answering agent_not_found, and the app renders that raw error where the terminal should be.
// Observed 2026-08-27 on codex, which was crash-looping on an exhausted quota.
//
// So re-report at every turn boundary, which also gives herdr a truthful working/idle state.
// NOTE the argument order: the pane id comes FIRST, before the flags.
function herdrAgent(state) {
  try {
    const f = join(homedir(), ".agent-bus", "crew-windows.txt");
    if (!existsSync(f)) return;
    const row = readFileSync(f, "utf8").split("\n")
      .map(l => l.split("\t"))
      .filter(c => c.length >= 4 && c[0] === PROJ && c[1] === "herdr" && c[2] === AGENT)
      .pop();
    if (!row || !row[3]) return;
    spawnSync("herdr", ["pane", "report-agent", row[3], "--source", "crew", "--agent", AGENT, "--state", state],
      { stdio: "ignore", timeout: 1500 });
  } catch { /* no herdr, or no row for this seat: the cmux/tmux paths do not need it */ }
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
// The failure STATE the room has already been told about. A seat that is down stays down, and
// saying so again every retry is repetition, not news — the monitoring doctrine this project holds
// everyone else to says report duration, not repetition. Observed cost: a permanently exhausted
// codex seat broadcast "DOWN" to `all` 31 times over six hours, and every broadcast is a turn for
// every live seat, so two working agents spent the evening reading the same sentence.
let announced = "";
let lastErrText = "";
// #5481: the turn exited 0 with a NULL/empty transcript — the Inception/Mercury trap. The provider
// burned its whole max_tokens budget on internal reasoning and returned a null completion; the
// runner used to read that silence as a clean turn while nothing was produced.
let lastEmptyOutput = false;
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

// Auth-failure markers in TURN OUTPUT. opencode prints its auth error ("401 Unauthorized" /
// "Invalid API key") and STILL exits 0, so a bare 0 from the CLI is not proof the turn ran
// (card #5405). The rules live in lib/classify-failure.mjs (#5868) so they are testable against
// the real specimens; classify() wraps them with the one-line verdict the seat log carries, and
// runTurn judges only the CLI's OWN output (the prompt echo is replay, not speech — the rules
// line "…deleting failing tests is forbidden." once classified healthy codex turns as auth).
function classify(exit) {
  const { reason, matched } = classifyFailure(exit, lastErrText, lastEmptyOutput);
  log(`classified ${reason} because ${matched}`);
  return reason;
}

async function reportFailure(exit, trigger, undelivered = 0) {
  consecFails++;
  const reason = classify(exit);
  const down = consecFails >= 2;
  const status = down ? `down: ${reason} · ${consecFails} fails` : `errored: ${reason}`;
  await api("/register", { session: SESSION, project: PROJ, status, llm: AGENT, model: MODEL, kind: "agent" }).catch(() => {});
  const hint = reason === "exhausted" ? " — needs `trantor swap`"
    : reason === "auth" ? " — check credentials"
    : reason === "backend-error" ? " — provider backend error (NOT quota): retry, or `trantor swap` to another provider"
    : reason === "missing-cli" ? " — CLI not on PATH"
    // #5481: name the suspected trap, not just the symptom — the dial lives in the provider's
    // opencode model config (limit.output), not in the runner.
    : reason === "empty-output" ? (AGENT === "inception"
        ? " — inception: raise max_tokens — diffusion burns budget on reasoning"
        : " — exit 0 with NULL output: raise the provider's max_tokens (reasoning may be eating the budget)")
    : "";
  // The count of messages this seat is HOLDING is the operator-actionable half of a failure: a
  // crashed pulse costs nothing, a crashed turn sitting on three escalations is someone waiting.
  const held = undelivered ? ` · holding ${undelivered} undelivered message${undelivered > 1 ? "s" : ""} (will retry)` : "";
  // #5869: the broadcast quotes failure context; keys never ride the bus.
  const text = redactKeys(down
    ? `🛑 ${SESSION} DOWN — ${consecFails} consecutive failures (${reason}, exit ${exit})${hint}${held}`
    : `⚠️ ${SESSION} turn FAILED (${trigger}, exit ${exit} · ${reason})${hint}${held}`);
  // Announce a CHANGE of state, never the continuation of one. The registered status above already
  // carries "down: exhausted · N fails" for anyone who looks, which is state and costs nobody a
  // turn; the broadcast is the event, and an unchanged state is not an event.
  const state = `${down ? "down" : "error"}:${reason}`;
  if (state !== announced) {
    announced = state;
    await api("/send", { from: SESSION, to: "all", text, project: PROJ, kind: "status" }).catch(() => {});
    // #5684: a broadcast does not wake anyone — the incident is the operator spotting dead seats
    // before the foreman did, twice in one morning. The same state-change event now goes DIRECT
    // to the project's orchestrator (direct = wake), gated identically so a standing outage says
    // it once. A seat that IS the orchestrator's own runner has nobody above it to wake.
    const orch = `${hostId()}:${PROJ}`;
    if (orch !== SESSION) await api("/send", { from: SESSION, to: orch, text, project: PROJ, kind: "alert" }).catch(() => {});
  } else {
    log(`still ${state} (${consecFails} fails) — already announced, staying quiet`);
  }
  cmuxStatus(down ? "down" : "error", "#ef6a6a", "alert", { alert: true, priority: 90 }); herdrAgent("blocked"); cmuxLog(`turn failed: ${reason} (exit ${exit})`, "error");
  log(`\x1b[31mreported failure to bus: ${reason} (exit ${exit})\x1b[0m`);
}

// ---- activity truth (#5965): the RUNNER is the source for this seat ----------------
// The app pulses a seat from its hub peer status. The runner is what actually knows when a
// turn starts and ends, so it reports the boundaries: `working · <trigger>` the moment a turn
// begins and `idle` the instant it lands clean. herdr's screen detection cannot see a
// runner-driven CLI mid-turn (it sets screen_detection_skipped for those panes), which is why
// seats used to read as idle while genuinely working — the desktop's herdr row is unreliable
// for runner seats, so it falls back to this hub status. Bounded 5s so a slow hub never delays
// the very turn it is reporting; one HTTP call per transition, never a poll.
async function registerStatus(status) {
  const url = HUB + "/register";
  const body = JSON.stringify({ session: SESSION, project: PROJ, status, llm: AGENT, model: MODEL });
  try {
    const opts = { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body };
    await fetch(url, { ...opts, headers: { ...opts.headers, ...signedHeaders(identity, url, opts) }, signal: AbortSignal.timeout(5000) });
  } catch {}
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
  text = redactKeys(text);   // #5869: the "asked" excerpt quotes the wake message — keys stay off the bus
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
    const payload = { from: SESSION, to: f, text: text.slice(0, 280), project: PROJ, kind: "receipt" };
    if (id) payload.re = id;
    await api("/send", payload).catch(() => {});
  }
  if (seen.size) log(`reported outcome to ${[...seen].join(", ")}`);
}

async function reportHealthy() {
  if (consecFails === 0) return;        // already healthy — don't spam
  consecFails = 0;
  // Recovery is a change too, so the next failure is news again.
  announced = "";
  await api("/register", { session: SESSION, project: PROJ, status: `active in ${PROJ}`, llm: AGENT, model: MODEL, kind: "agent" }).catch(() => {});
  await api("/send", { from: SESSION, to: "all", text: `✅ ${SESSION} recovered`, project: PROJ, kind: "status" }).catch(() => {});
  cmuxStatus("ok", "#14b8a6", "check"); herdrAgent("idle");
}

let sid = "";
async function runTurn(prompt, isFirst, trigger = "kickoff") {
  TURN++; banner(trigger);
  const t0 = Date.now();
  // #5965 — TURN START. The hub peer row is where the app reads activity from, and the runner is
  // the only one who knows a turn is starting, so say so before the CLI spawn (awaited: the spawn
  // below blocks the loop, an unawaited fetch would not leave the machine until the turn ended).
  await registerStatus(`working · ${trigger}`);
  const pf = join(homedir(), ".agent-bus", `turn-${AGENT}-${PROJ}.txt`);
  appendFileSync(pf, "", { flag: "w" }); // truncate
  appendFileSync(pf, prompt);
  // #5868: where HEAD stood when the turn began. A turn that moved it shipped real work, and an
  // exit-0 turn with real output must never be re-labelled "auth" by the #5405 escalation — the
  // qwen specimen committed aa3c340 while its captured stream still tripped the auth regex.
  const headBefore = gitOut(["rev-parse", "HEAD"], TURN_DIR);
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
  cmuxStatus("building", "#4a90d9", "hammer", { priority: 50 }); herdrAgent("working");
  // inherit stdio so the window shows the agent working live; also capture for sid-parsing.
  // Tee stderr to ERRF (still shown live in the window) so a failed turn can be classified.
  try { appendFileSync(ERRF, "", { flag: "w" }); } catch {}   // truncate
  lastEmptyOutput = false;
  // pipefail: without it the sid-capture `| tee` makes a FAILED turn exit 0 (tee's status),
  // so the failure reporter never fires and a dead seat heartbeats green on the bus.
  // A CLI's own explanation for quitting often goes to STDOUT, not stderr — Claude's usage-limit
  // notice is the case that bit us: ERRF stayed empty, so a plainly exhausted seat was reported as
  // `crashed` and nobody knew to swap it. sid seats already fold stdout into the ERRF stream via
  // `tee /dev/stderr`; the rest now tee straight into ERRF. A real pipeline (not a process
  // substitution) so bash waits for tee to flush before we read the file back.
  // #5869: redaction rides IN the pipeline — lib/redact.mjs is a tee replacement that echoes
  // stdin verbatim to the live window and appends only REDACTED bytes to ERRF, so a CLI that
  // echoes its environment never parks a provider key in a file every seat can read. The tee
  // topology is load-bearing (#5481): stdout+stderr must still BOTH land in ERRF, and the sid
  // path still folds stdout in via /dev/stderr → the --tee2 hop below.
  const SCRUB = `node ${join(import.meta.dirname, "..", "lib", "redact.mjs")}`;
  const inner = cli.sid ? `${cmd} | tee /dev/stderr` : `${cmd} | ${SCRUB} --tee ${ERRF}`;
  // #5684: runTurn is spawnSync, so the runner cannot watch its own turn — a DETACHED watchdog
  // does. Armed by a stamp file, disarmed when the turn ends (stamp removed below); a turn past
  // the window with no ERRF growth earns ONE direct stall report to the foreman, never a kill.
  const WD_MS = Number(process.env.TRANTOR_TURN_WATCHDOG_MS || 15 * 60 * 1000);
  const STAMPF = join(homedir(), ".agent-bus", `turnstamp-${AGENT}-${PROJ}.json`);
  try {
    writeFileSync(STAMPF, JSON.stringify({ turn: TURN, startedAt: Date.now() }));
    const wd = spawn(process.execPath, [join(import.meta.dirname, "turn-watchdog.mjs"), STAMPF, ERRF, String(WD_MS), SESSION, PROJ, HUB],
      { detached: true, stdio: "ignore" });
    wd.unref();
  } catch {}
  const r = spawnSync("/bin/bash", ["-c", `set -o pipefail; { ${inner} ; } 2> >(${SCRUB} --tee2 ${ERRF})`], {
    cwd: TURN_DIR, encoding: "utf8", stdio: cli.sid ? ["ignore", "pipe", "inherit"] : "inherit",
    env: { ...process.env, RELAY_URL: HUB, RELAY_AGENT: AGENT, RELAY_SESSION: SESSION, RELAY_PROJECT: PROJ,
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
  try { unlinkSync(STAMPF); } catch {}   // turn over — disarm the watchdog
  // #5869: scrub AT REST, synchronously, before anything reads the file back. The stderr hop is
  // a process substitution bash does not wait for, so this pass also catches its tail — the
  // auth classifier and the empty-output check below must judge REDACTED text and a settled file.
  try { writeFileSync(ERRF, redactKeys(readFileSync(ERRF, "utf8"))); } catch {}
  // #5868: classify only what the CLI itself said. The transcript replays the whole turn prompt
  // (rules, lessons, the wake text) — and those lines once classified healthy codex turns as
  // auth ("…is forbidden.") and exhausted ("retries burn quota"). Prompt lines are stripped
  // before anything downstream looks at the text.
  let ownOut = "";
  try { ownOut = stripPromptEcho(readFileSync(ERRF, "utf8"), readPromptText(pf)); } catch { ownOut = ""; }
  lastErrText = ownOut.slice(-4000);
  if (cli.sid && r.stdout) { const m = r.stdout.match(cli.sid); if (m) sid = m[1]; }
  const realExit = r.status;
  // A zero exit is NOT proof the turn ran: opencode prints "401 Unauthorized" / "Invalid API key"
  // and exits 0, so a bare 0 made the runner ack "✅ done", clear the pending queue and heartbeat
  // green through an auth outage (card #5405). Cross-check the turn output and treat an
  // exit-0-with-auth turn as FAILED — but ONLY when the CLI's own output is short enough to be
  // just the error (#5868): a long output is a real answer, and a warning inside it must not
  // fail the turn. Telemetry keeps the REAL exit; the returned code is the effective one every
  // call site branches on (kickoff, pulse, deliverWake).
  let effExit = realExit;
  let authHit = "";
  // #5868: a NEW commit since turn start is real work, and an exit-0 turn with real output is
  // never re-labelled auth — the qwen specimen exited 0 with a shipped commit (aa3c340) while a
  // short capture of echoed contract text tripped the regex.
  const newCommit = !!headBefore && gitOut(["rev-parse", "HEAD"], TURN_DIR) !== headBefore;
  if (realExit === 0 && looksLikeAuthDeath(ownOut, newCommit)) {
    effExit = 1;
    authHit = AUTH_MARKER_RE.exec(ownOut)[0];
    log(`\x1b[31mexit 0 but the turn output IS an auth failure — treating as FAILED (auth, "${authHit}")\x1b[0m`);
  }
  // #5481: the Inception/Mercury trap — exit 0 with a NULL completion. ERRF is the TOTAL output
  // capture, not just stderr: every seat's stdout is tee'd into it (`| tee -a ERRF` for the
  // opencode family, `| tee /dev/stderr` + the stderr tee for sid seats — line ~448). So an
  // empty ERRF on a clean exit means the turn produced nothing on EITHER stream — and every
  // real CLI prints something on success (drill C pins that), so silence is the trap, not a
  // quiet victory. (Integration note: this was nearly "fixed" into stdout-only detection that
  // never fired — the tee topology is the load-bearing fact; keep this comment with it.)
  // The judgment now runs on the ECHO-STRIPPED text (#5868): a CLI that replays the prompt but
  // does no work has still produced nothing of its own.
  if (realExit === 0 && effExit === 0 && !lastErrText.trim()) {
    effExit = 1;
    lastEmptyOutput = true;
    log("\x1b[31mexit 0 but the turn produced NO output — treating as FAILED (empty-output)\x1b[0m");
  }
  // #5868: the verdict rides the telemetry row so a classification survives the pane scrolling
  // away — the same "classified X because Y" shape the runner logs, in the seat's jsonl forever.
  const verdict = verdictFor(realExit, effExit, lastEmptyOutput, ownOut);
  telemetry({ ts: Date.now(), agent: AGENT, project: PROJ, turn: TURN, trigger, model: MODEL || "cli-default", duration_ms: Date.now() - t0, exit: realExit, effExit, authFailed: effExit !== realExit, emptyOutput: lastEmptyOutput, verdict });
  log(`turn ended (exit ${realExit}${effExit !== realExit ? ` → effective ${effExit} (${lastEmptyOutput ? "empty-output" : "auth"})` : ""}, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  if (realExit === 0 && effExit === 0) { cmuxStatus("idle", "#8a94a6", "robot"); herdrAgent("idle"); }   // finished this turn, waiting for the next
  // #5965 — TURN END. A clean exit means the seat is idle again; say so right away so the app stops
  // pulsing it even before the next /poll heartbeat. Failure keeps reportFailure's down/errored.
  if (realExit === 0 && effExit === 0) await registerStatus("idle");
  return effExit;
}

// ---- main loop ----
const KICKOFF = process.env.CREW_KICKOFF ||
  `You just joined (your arrival was already announced on the bus). 1) relay_inbox — if a contract for you is already waiting, do it now per the Rules. 2) End your turn.\n\n${RULES}`;

let LESSONS_RAW = [];
async function loadLessons() {
  try {
    const { lessons } = await api(`/lessons?agent=${encodeURIComponent(AGENT)}`);
    if (lessons?.length) LESSONS_RAW = lessons;
  } catch {}
}

// card #5683: every section of a turn prompt is capped (bin/crew-payload.mjs) and the whole
// payload has ONE hard total cap. Codex burned 306k tokens into a remote-compact 404 crash-loop
// because a resumed session re-fed the full lessons block (22,298 of the 24,698 chars in its last
// turn file — 90%) plus an unbounded broadcast backlog on EVERY turn, redelivery after redelivery.
// Below the caps the composition is byte-identical to the old concatenation.
function composedTurn({ base = "", wakeText = "", ctxText = "", againText = "", tailText = "", rulesText = "", lessons = null }) {
  const built = composePrompt([
    { name: "base", text: base },
    { name: "wake", text: wakeText, trim: "truncate", order: 4 },
    { name: "ctx", text: ctxText, trim: "drop", order: 1 },
    { name: "again", text: againText },
    { name: "tail", text: tailText },
    { name: "rules", text: rulesText, trim: "drop", order: 3 },
    { name: "lessons", text: lessons?.text || "", trim: "drop", order: 2 },
  ]);
  const parts = built.sections.filter(s => s.chars).map(s => `${s.name} ${s.chars.toLocaleString("en-US")}c`).join(" · ");
  const lessonsNote = lessons && lessons.total ? ` (lessons ${lessons.kept}/${lessons.total})` : "";
  log(`payload: ${parts}${lessonsNote} → ${built.prompt.length.toLocaleString("en-US")}c${built.truncated ? ` \x1b[33mTRUNCATED — ${built.dropped.join("; ")}\x1b[0m` : ""}`);
  return built.prompt;
}

const RECEIPT_MARKER = "✅ done on";
const CARD_REF_RE = /#\d{1,7}(?!\d)/;

// Runner-authored metadata is bus state, not work. Typed messages are authoritative; `re` and the
// stable text marker keep a mixed-version crew safe while older runners are still on the bus.
function isReceipt(message) {
  const text = String(message?.text || "").trimStart();
  return message?.kind === "receipt" || Number(message?.re) > 0 || text.startsWith(RECEIPT_MARKER);
}

function isStatusBroadcast(message) {
  if (message?.to !== "all") return false;
  if (message?.kind === "status") return true;
  const text = String(message?.text || "").trim();
  return /^[A-Za-z0-9_.-]+ reporting — ready for a contract\b/.test(text)
    || /^[✅⚠️🛑]\s+\S+\s+(?:recovered|turn FAILED|DOWN)\b/.test(text);
}

function isContract(message) {
  const text = String(message?.text || "");
  return message?.kind === "contract" || /^\s*contract\s*:/i.test(text) || CARD_REF_RE.test(text);
}

function isRunnerSession(session) {
  const suffix = `:${PROJ}`;
  const name = String(session || "");
  if (!name.endsWith(suffix)) return false;
  const label = name.slice(0, -suffix.length);
  // Crew labels are CLI/provider slugs. Host sessions keep their machine-style identity and remain
  // valid direct assigners; runner-to-runner prose needs `contract:` or a card reference.
  return /^[a-z0-9_.-]+$/.test(label) && !label.startsWith("hub:");
}

function shouldWake(message) {
  if (isReceipt(message) || isStatusBroadcast(message)) return false;
  if (message?.to === SESSION) {
    if (message?.kind === "status") return false;
    return !isRunnerSession(message?.from) || isContract(message);
  }
  return message?.to === "all"
    && isContract(message)
    && (message.text.includes(`@${AGENT}`) || message.text.toLowerCase().includes(`${AGENT}:`));
}

function askedExcerpt(message) {
  let text = String(message?.text || "").replace(/\s+/g, " ").trim();
  const nested = text.search(/\s+[·|]\s*asked\s*:/i);
  if (nested >= 0) text = text.slice(0, nested).trim();
  return text.slice(0, 120);
}

(async () => {
  await loadLessons();
  // start cursor at the CURRENT tip so we don't replay history
  let cursor = 0;
  try { const r = await api(`/inbox?session=${encodeURIComponent(SESSION)}&since=0`); cursor = r.cursor || 0; } catch {}
  // kind "agent" on every beat (#6075): the peer row's kind is the hub's OWN record of what a
  // session is — the overseer's declared-crew exemption reads it, and on the remote hub there is
  // no crew-windows.txt to fall back to. /register preserves absent fields, so a seat running an
  // older runner never loses a kind an updated one stamped.
  await api("/register", { session: SESSION, project: PROJ, status: "crew member booting", llm: AGENT, model: MODEL, kind: "agent" }).catch(() => {});
  // Announce runner-side, signed as THIS seat. Asking the seat to announce itself sent glm's hello
  // out under deepseek's identity whenever opencode seats shared one MCP daemon (lesson on the bus,
  // 2026-07-29): the runner process is per-seat by construction, so its signature cannot be borrowed.
  try {
    const { sfetchJson } = await import("../lib/signed-fetch.mjs");
    const { loadOrCreate } = await import("../lib/identity.mjs");
    await sfetchJson(`${HUB}/send`, {
      identity: loadOrCreate(SESSION, "agent"),
      payload: { from: SESSION, to: "all", project: PROJ, kind: "status", text: `${AGENT} reporting — ready for a contract${MODEL ? ` (${MODEL})` : ""}` },
      signal: AbortSignal.timeout(2500),
    });
  } catch {}

  // Wake messages this seat has PULLED off the bus but not yet worked successfully, plus the
  // broadcasts batched behind them. Restored from disk first: a runner that was killed mid-turn
  // (or a machine that rebooted) still owes those messages, and the hub will never send them again.
  const restored = loadPending();
  let pendingWake = restored.wake.filter(shouldWake);
  let pendingBcast = restored.bcast.filter(m => !isReceipt(m) && !isStatusBroadcast(m));
  let retryAt = 0;            // 0 = deliver at the next opportunity
  let deliveryFails = 0;      // consecutive failed attempts at the SAME pending batch
  if (pendingWake.length) log(`\x1b[33m${pendingWake.length} message(s) survived from a previous run — redelivering\x1b[0m`);

  const ec0 = await runTurn(composedTurn({ base: KICKOFF, lessons: pickLessons(LESSONS_RAW, "") }), true, "kickoff");
  if (ec0) await reportFailure(ec0, "kickoff", pendingWake.length);   // a failed kickoff = the "fired up, died, nobody knew" case
  let lastTurnAt = Date.now();
  if (PULSE_MS) log(`pulse armed — mission re-read every ${Math.round(PULSE_MS / 1000)}s (${MISSION_FILE})`);
  log(`parked — long-polling the bus as ${SESSION} (free; this poll is also the heartbeat)`);

  while (true) {
    // pulse first: a due mission beat runs even on a silent bus. Measured from the END of the
    // last turn, so a long turn doesn't stack an immediate pulse on top of itself.
    if (PULSE_MS && Date.now() - lastTurnAt >= PULSE_MS) {
      const ecp = await runTurn(composedTurn({ base: PULSE_PROMPT + "\n\n", rulesText: RULES, lessons: pickLessons(LESSONS_RAW, PULSE_PROMPT) }), false, "pulse");
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
      msgs = r.messages || [];
      if (r.cursor !== undefined && r.cursor !== null && Number.isFinite(Number(r.cursor))) {
        const reportedCursor = Number(r.cursor);
        if (reportedCursor < cursor) log(`cursor rewound by hub ${cursor} -> ${reportedCursor}`);
        cursor = reportedCursor;
      }
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
    // A receipt is the terminal state of a contract, never a new contract. Consume typed receipts,
    // reply-linked outcomes, and the old stable marker before direct-address logic sees them. Status
    // broadcasts are presence chatter and are dropped rather than saved as future prompt context.
    msgs = msgs.filter(m => !isReceipt(m) && !isStatusBroadcast(m));
    // #5760 (the night of 08-31): the hub's hourly "same-project-sessions" FYI woke every seat
    // into a real CLI turn — three wedged for hours mid-chatter, one on the metered pool. That
    // kind is pure coordination CONTEXT ("no human needs to relay this" — and no turn needs to
    // burn on it either): batch it like a broadcast. file-conflict and linked-activity overseer
    // warnings still wake — those are actionable by the seat right now.
    const fyi = msgs.filter(m => m.from === "hub:duty" && String(m.text || "").startsWith("🤝 OVERSEER same-project-sessions"));
    const rest = msgs.filter(m => !fyi.includes(m));
    const direct = rest.filter(m => m.to === SESSION && shouldWake(m));
    const mentions = rest.filter(m => m.to === "all" && shouldWake(m));
    const bcast = [...rest.filter(m => m.to === "all" && !mentions.includes(m)), ...fyi];
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
        kind: "status", text: `⚠️ ${SESSION} dropped ${dropped.length} undelivered message(s) — queue hit its ${PENDING_MAX} cap during a failure streak` }).catch(() => {});
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
    const wakeCapped = capWake(wake);
    const bcastCapped = capBcast(pendingBcast);
    const wakeText = wakeCapped.text
      ? `NEW BUS MESSAGE${wake.length > 1 ? "S" : ""} for you:\n${wakeCapped.text}\n`
      : "";
    const ctxText = bcastCapped.text
      ? `\nFYI broadcasts since your last turn (context only):\n${bcastCapped.text}\n`
      : "";
    // Say plainly that this is a second look. Without it the model re-reads an old escalation as
    // brand new and can redo work it already half-did before the turn died.
    const againText = deliveryFails
      ? `\n(REDELIVERY, attempt ${deliveryFails + 1} — an earlier turn failed before acting on ${wake.length > 1 ? "these" : "this"}. Check what you already did before repeating it.)\n`
      : "";
    await loadLessons();
    const lessons = pickLessons(LESSONS_RAW, wakeCapped.text + " " + bcastCapped.text);
    const trigger = wake.some(m => m.to === SESSION) ? "direct message" : "@mention";
    // Who is owed an answer, captured BEFORE the turn: pendingWake is cleared on success.
    const assigners = [];
    for (const m of wake) if (m.from && !assigners.some(a => a.from === m.from)) assigners.push({ from: m.from, id: m.id });
    const asked = askedExcerpt(wake[0]);
    const tStart = Date.now();
    const prompt = composedTurn({
      wakeText, ctxText, againText,
      tailText: "\nAct on what's addressed to you, then end your turn.\n\n",
      rulesText: RULES, lessons,
    });
    const ec = await runTurn(prompt, false, deliveryFails ? `${trigger} (redelivery)` : trigger);
    const secs = Math.round((Date.now() - tStart) / 1000);
    if (ec) {
      deliveryFails++;
      const wait = RETRY_MS[Math.min(deliveryFails - 1, RETRY_MS.length - 1)];
      retryAt = Date.now() + wait;
      savePending(pendingWake, pendingBcast);
      await reportFailure(ec, "message", pendingWake.length);
      // The room hears the broadcast above; the one who is actually blocked hears it directly.
      await notifyAssigners(assigners,
        `⚠️ your contract FAILED on ${SESSION} (exit ${ec}, ${classify(ec)}) · retrying in ${Math.round(wait / 1000)}s · asked: "${asked}"`);
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

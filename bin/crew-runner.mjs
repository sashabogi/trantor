#!/usr/bin/env node
// trantor crew runner — keeps a crew agent alive without burning tokens: it long-polls the bus
// (zero tokens) and resumes the CLI with each message. Usage: node crew-runner.mjs <agent> [dir]
import { execSync, spawnSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, appendFileSync, mkdirSync, realpathSync } from "node:fs";
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
import {
  cardRefs, wakeCard, carriesWork, parseTurnTokens, parseResetAt, reasonWithBalances, quotaResetAt, PARKING_REASONS,
  senderProjectOf, isLinkedProject, stateSkipReason,
} from "../lib/turn-policy.mjs";
import {
  auditDutyNudges, claimDutyNudges, claudeTranscriptDir, dutyEscalations, dutyNudgeDirective,
  observedDutyNudgeIds,
} from "../lib/duty-nudges.mjs";
import {
  BREAKER_WINDOW, STATE_ENV, TURN_RESULT_SCHEMA,
  breakerVerdict, describeTurn, hasJsonSchemaFlag, parseEnvelope, renderCardTail, runStep,
} from "../lib/state/driver.mjs";
import { costLine } from "../lib/state/cost.mjs";

const AGENT = process.argv[2];
const DIR = process.argv[3] || process.cwd();
// Crew agents MUST share the orchestrator's project key (one repo = one lane).
// RELAY_PROJECT is inherited from crew.mjs (the host's resolved key); else fall
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

// #6154: opencode records each session with its directory; the newest row for OUR worktree is the
// only session a resume may pin. Fail-open: no row means a fresh turn, never a stranger's session.
const OC_DB = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "opencode.db");
function ocSid(dir) {
  try {
    // opencode stores the directory as IT sees its cwd, which on macOS can be the /private/var
    // realpath of the /var/... path the runner holds — query both spellings.
    const dirs = [dir];
    try { const real = realpathSync(dir); if (real !== dir) dirs.push(real); } catch {}
    const list = dirs.map((d) => `'${d.replaceAll("'", "''")}'`).join(", ");
    const q = `SELECT id FROM session WHERE directory IN (${list}) ORDER BY time_updated DESC LIMIT 1;`;
    const r = spawnSync("sqlite3", ["-readonly", OC_DB, q], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    const id = String(r.stdout || "").trim();
    return /^ses_[A-Za-z0-9]+$/.test(id) ? id : "";
  } catch { return ""; }
}
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
// The boot line records the HUB this runner bound to, so a split-brain is diagnosable from disk.
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
  // A long-poll whose socket dies silently would hang fetch forever, so every call carries a
  // deadline of the poll's own wait window plus slack; a dead poll surfaces as a retryable error.
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
  // Label with the REAL seat identity (this is the DISPLAY path, distinct from the bus identity).
  // Pill = "<agent> · <state>" in the agent's brand color; alerts keep their alarm color.
  const col = opts.alert ? color : (BRAND_HEX[AGENT.toLowerCase()] || color);
  try { spawnSync(CMUX_BIN, ["set-status", SESSION, `${AGENT} · ${value}`, "--color", col, "--icon", icon, "--priority", String(opts.priority ?? 0)], { stdio: "ignore", timeout: 1500, env: { ...process.env, CMUX_QUIET: "1" } }); } catch {}
}
// herdr drops a pane's agent registration when the process inside exits, and a seat's CLI exits
// every turn, so re-report at each turn boundary. Argument order: pane id FIRST, then the flags.
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
  // #6154: `run -c` resumes the globally last session on this machine, any project's, and its stored
  // directory becomes the path root. So every spawn pins --dir and a resume pins -s (ocSid below).
  deepseek: { first: `opencode run --dir {DIR}{M} "$(cat {P})"`,
              next:  `opencode run --dir {DIR} -s {SID}{M} "$(cat {P})"`, mflag: " -m ", pinned: true, env: join(homedir(), ".token-scrooge", ".env") },
  opencode: { first: `opencode run --dir {DIR}{M} "$(cat {P})"`,
              next:  `opencode run --dir {DIR} -s {SID}{M} "$(cat {P})"`, mflag: " -m ", pinned: true, env: join(homedir(), ".token-scrooge", ".env") },
  // OpenRouter rides the opencode CLI exactly like deepseek/glm, but under its OWN agent label so
  // its bus identity is `openrouter:<project>` (RELAY_AGENT is set per-spawn) — never colliding with
  // the glm `opencode` seat. Model ids come pre-qualified (`openrouter/<vendor>/<model>`). Sources
  // the token-scrooge .env so an existing OPENROUTER_API_KEY authenticates with no extra wiring.
  openrouter: { first: `opencode run --dir {DIR}{M} "$(cat {P})"`,
              next:  `opencode run --dir {DIR} -s {SID}{M} "$(cat {P})"`, mflag: " -m ", pinned: true, env: join(homedir(), ".token-scrooge", ".env") },
  claude:   { first: `claude{M} -p "$(cat {P})" --dangerously-skip-permissions`,
              next:  `claude -c{M} -p "$(cat {P})" --dangerously-skip-permissions`,
              // TDD §4.6: a state step is a fresh `claude -p` (no `-c`) carrying the assembled prefix, held
              // to the TurnResult grammar by --json-schema; test/state/test-runner-state.mjs pins the strings.
              stateNext: `claude{M} -p "$(cat {P})" --dangerously-skip-permissions --output-format json --json-schema "$(cat {S})"`,
              mflag: " --model " },
  // DeepSeek Harness: every turn is a fresh session (headless has no resume), so the seat leans on
  // the wake prompt and the board. `trantor connect` builds ~/.dsh/profiles/trantor; no model flag.
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
const RULES = process.env.RUNNER_RULES || `Rules: you are ${SESSION} on the trantor crew. Before starting a card, read YOUR card: relay_board with card:<id> (the card, its deps, its notes, and the last five done cards whose title shares a word); never the whole board. Work your assigned file(s), report on the bus (relay_send, <280 chars), move your Kanban card as you go with a NOTE saying what you did (doing -> testing -> done; in 'testing' run YOUR OWN test file — never the full npm test, suites collide across seats — plus \`node bin/slop-gate.mjs\` when the repo has one: it lints ONLY your changed files against the anti-slop rules, and a card must not reach done with slop-gate failing; use 'failed' + a report if anything breaks). If you need something from another session, message THAT SESSION (relay_peers to find its id, relay_send to reach it) — never ask the human to pass it along; carrying messages between agents is the job this bus exists to remove. When your work for THIS message is finished, END YOUR TURN — do NOT park, do NOT loop relay_wait; the runner waits for you and will wake you with the next message. Path discipline: build/test from your worktree root ${TURN_DIR} with absolute paths or --manifest-path/--prefix instead of cd-ing into subdirs, and put anything that must land outside the repo under ${TURN_DIR}/.agent-bus-out/ (gitignored) — never ~/.agent-bus. Cross-project action is a breach: never \`trantor up\` a crew, register a seat, or send a card/contract into a project other than ${PROJ} unless the operator ran \`trantor policy link ${PROJ} <other> --reason "<why>"\` first — the hub, the CLI and this runner all refuse it mechanically, so ask the operator to link the projects instead of routing around the refusal.`;

// ---- the pulse --------------------------------------------------------------
// RUNNER_PULSE_MS re-runs an orchestrator seat's mission note on a cadence when the bus is silent;
// an empty mission means STAND BY, never invented work.
const PULSE_MS = Math.max(0, Number(process.env.RUNNER_PULSE_MS || 0));
const MISSION_FILE = process.env.RUNNER_MISSION_FILE || "MISSION.md";
const PULSE_PROMPT = `[pulse] Re-read your mission note (${MISSION_FILE} in your working directory) and continue your mission. Check on your children and your board, unblock what is stuck, and record what you did. If the mission note is missing, empty, or has no actionable mission, reply ONLY that you are standing by and end your turn — do NOT invent work, create files, or spawn anything.`;

// ---- failure visibility ----------------------------------------------------
// A failed turn would otherwise re-park green on the bus; every non-zero turn is surfaced in real
// time so the orchestrator and `trantor swap` can react, and presence flips to errored/down.
let consecFails = 0;
// The failure state the room has already been told: a seat that is down stays down, and repeating
// it every retry costs a turn for every live seat (monitoring doctrine: duration, not repetition).
let announced = "";
let lastErrText = "";
// #5481: the turn exited 0 with a NULL/empty transcript — the Inception/Mercury trap. The provider
// burned its whole max_tokens budget on internal reasoning and returned a null completion; the
// runner used to read that silence as a clean turn while nothing was produced.
let lastEmptyOutput = false;
const ERRF = join(homedir(), ".agent-bus", `err-${AGENT}-${PROJ}.txt`);
const DUTY_NUDGES = process.env.RUNNER_DUTY_NUDGES === "1";
const DUTY_NUDGE_STATE = process.env.RUNNER_DUTY_NUDGE_STATE
  || join(homedir(), ".agent-bus", "duty-nudged.json");
const TRANSCRIPT_DIR = claudeTranscriptDir(TURN_DIR, homedir());

function startDutyNudgeWatcher(plan, sinceMs) {
  if (!DUTY_NUDGES || !plan.items.length) return () => {};
  const stopPath = join(homedir(), ".agent-bus", `duty-nudge-watch-${process.pid}-${TURN + 1}.stop`);
  try { unlinkSync(stopPath); } catch {}
  const child = spawn(process.execPath, [
    join(import.meta.dirname, "duty-nudge-watch.mjs"), TRANSCRIPT_DIR, DUTY_NUDGE_STATE,
    String(sinceMs), JSON.stringify(plan), stopPath,
  ], { detached: true, stdio: "ignore" });
  child.unref();
  return () => { try { writeFileSync(stopPath, ""); } catch {} };
}

// ---- undelivered wake messages (the runner owns delivery, not the hub) ----
// The hub hands a message out exactly once, so a turn that died took its wake with it. Here a
// message is consumed only when a turn exits 0; the queue lives on disk and retries on backoff.
const PENDF = join(homedir(), ".agent-bus", `pending-${AGENT}-${PROJ}.json`);
// A cap, so a long outage cannot grow the queue without bound. Overflow drops the OLDEST and says
// so on the bus — a silent drop is the exact failure this whole mechanism exists to end.
const PENDING_MAX = 50;
// Redelivery backoff: fast first, landing at 15 minutes ("properly down", not a retry storm).
// TRANTOR_RETRY_MS (comma-separated ms) shortens the ladder for the redelivery drill.
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

// Auth failures in TURN OUTPUT: opencode prints its auth error and still exits 0 (#5405). The rules
// live in lib/classify-failure.mjs (#5868); runTurn judges only the CLI's own output, not the echo.
function classify(exit) {
  const { reason, matched } = classifyFailure(exit, lastErrText, lastEmptyOutput);
  log(`classified ${reason} because ${matched}`);
  return reason;
}

async function reportFailure(exit, trigger, undelivered = 0, reasonOverride = "") {
  consecFails++;
  const reason = reasonOverride || classify(exit);
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
  return reason;
}

// ---- a dead seat is not retried (#6134) -------------------------------------------------------
// Against a spent plan or a rejected key the ladder never succeeds, so those two reasons PARK:
// queue kept, ladder stopped, room told once with the reset time. `trantor up` resumes.
let parkAnnounced = false;
async function parkSeat(reason, undelivered, resetHint = 0) {
  // A seat that went QUIET printed no wall message to parse (#6131), so its own balance row is the
  // only place the reset time exists. Output first when there is any: it is this turn's evidence.
  const resetAt = parseResetAt(lastErrText) || resetHint;
  const when = resetAt ? new Date(resetAt).toLocaleString() : "";
  if (!parkAnnounced) {
    parkAnnounced = true;
    const text = redactKeys(`⛔ ${SESSION} PARKED (${reason}) — holding ${undelivered} message(s), redelivery stopped ${when ? `until ${when}` : `until \`trantor up ${AGENT}\``}`);
    await api("/send", { from: SESSION, to: "all", text, project: PROJ, kind: "status" }).catch(() => {});
    const orch = `${hostId()}:${PROJ}`;
    if (orch !== SESSION) await api("/send", { from: SESSION, to: orch, text, project: PROJ, kind: "alert" }).catch(() => {});
  }
  log(`\x1b[31mparked (${reason})${when ? ` — retrying after ${when}` : " — no reset time in the output; waiting for a restart"}\x1b[0m`);
  // The alarm for "the bus is stuck" cannot itself be a bus message, so a park also rings a bell
  // the operator can hear out of band, once per park.
  notifyOperator(`Trantor: ${SESSION} PARKED (${reason})`,
    `${undelivered} message(s) held${when ? ` — retrying after ${when}` : ` — needs \`trantor up ${AGENT}\``}`);
  // No reset time means no timer can clear it: hold until the operator restarts the seat.
  return resetAt || Number.MAX_SAFE_INTEGER;
}

/**
 * Reach the operator on a channel independent of the bus, the hub and any session. Best-effort,
 * never fatal; TRANTOR_NO_DESKTOP_NOTIFY=1 silences it for headless boxes and test runs.
 */
function notifyOperator(title, body) {
  if (process.env.TRANTOR_NO_DESKTOP_NOTIFY === "1") return;
  try {
    // Always leave a durable trace first: a notification can be missed or suppressed, a file cannot.
    // This is what `trantor doctor` reads, so the escalation survives a machine nobody was sitting at.
    const alertsPath = join(homedir(), ".agent-bus", "alerts.jsonl");
    appendFileSync(alertsPath, `${JSON.stringify({ ts: Date.now(), session: SESSION, title, body })}\n`);
  } catch {}
  try {
    if (process.platform === "darwin") {
      // osascript is present on every mac; no dependency to install and nothing to keep running.
      const esc = (s) => String(s).replace(/["\\]/g, "\\$&");
      spawnSync("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`],
        { timeout: 5000, stdio: "ignore" });
    }
  } catch {}
}

// The seat's own balance rows, for the #6131 read: a stalled turn that printed nothing on a seat
// whose plan is spent is exhaustion, not a crash. Bounded and best-effort — a slow provider API
// must never hold up the failure path, and an unreachable one just leaves the reason as it was.
async function balanceRows() {
  try {
    const { fetchBalances } = await import("../lib/balances.mjs");
    // Same key sources the crew itself uses: QWEN_API_KEY (and most others) live in
    // ~/.agent-bus/.env, not in the runner's inherited environment — reading bare process.env
    // here would report "no key" and quietly leave every silent turn classified as a crash.
    const { resolveKeys } = await import("../lib/provider-keys.mjs");
    return await Promise.race([
      fetchBalances(resolveKeys(process.env), { only: [AGENT] }),
      new Promise((r) => setTimeout(() => r([]), 4000)),
    ]);
  } catch { return []; }
}

// ---- activity truth (#5965): the RUNNER is the source for this seat ----------------
// herdr cannot see a runner-driven CLI mid-turn, so the runner reports turn boundaries to the hub:
// `working · <trigger>` at start, `idle` on a clean landing. Bounded 5s, one call per transition.
async function registerStatus(status) {
  const url = HUB + "/register";
  const body = JSON.stringify({ session: SESSION, project: PROJ, status, llm: AGENT, model: MODEL });
  try {
    const opts = { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body };
    await fetch(url, { ...opts, headers: { ...opts.headers, ...signedHeaders(identity, url, opts) }, signal: AbortSignal.timeout(5000) });
  } catch {}
}

// ---- telling the ASSIGNER, mechanically ------------------------------------
// Whoever sent the wake is told directly what became of it: a direct message wakes, a broadcast
// does not, and a seat that finished silently left the orchestrator blind.
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
  // Recovery is a change too, so the next failure is news again — a park included.
  announced = "";
  parkAnnounced = false;
  await api("/register", { session: SESSION, project: PROJ, status: `active in ${PROJ}`, llm: AGENT, model: MODEL, kind: "agent" }).catch(() => {});
  await api("/send", { from: SESSION, to: "all", text: `✅ ${SESSION} recovered`, project: PROJ, kind: "status" }).catch(() => {});
  cmuxStatus("ok", "#14b8a6", "check"); herdrAgent("idle");
}

// ---- Trantor State Phase 2a — the flagged path (TDD §4.1, §4.6, §7.3) -----------------------
// Off by default, and off means the transcript path runs unchanged. Reachable only when the operator
// set TRANTOR_STATE_ASSEMBLE=1, the seat is `claude` (§7.3) and the CLI carries --json-schema (§6).
const STATE_FLAG_ON = process.env[STATE_ENV] === "1";
const STATE_SCHEMA_FILE = join(homedir(), ".agent-bus", `state-schema-${AGENT}-${PROJ}.json`);
const STATE_MODE = (() => {
  if (!STATE_FLAG_ON) return false;
  if (AGENT !== "claude") { log(`${STATE_ENV}=1 but this seat is '${AGENT}' — state mode is claude-only (TDD §7.3); staying on the transcript path`); return false; }
  const probe = hasJsonSchemaFlag((bin, args) => spawnSync(bin, args, { encoding: "utf8", timeout: 20000 }));
  if (!probe) { log(`\x1b[33m${STATE_ENV}=1 but this claude CLI has no --json-schema — state mode stays OFF (TDD §6)\x1b[0m`); return false; }
  try {
    mkdirSync(join(homedir(), ".agent-bus"), { recursive: true, mode: 0o700 });
    writeFileSync(STATE_SCHEMA_FILE, JSON.stringify(TURN_RESULT_SCHEMA), { mode: 0o600 });
  } catch (e) { log(`\x1b[33mstate mode OFF — could not write ${STATE_SCHEMA_FILE}: ${e.message}\x1b[0m`); return false; }
  // #7060: the checks above prove CONFIGURATION, not the prompt, so say "armed" and name the one
  // thing that engages it; each turn then reports which path it took.
  log(`\x1b[36mTrantor State: ASSEMBLE armed for this seat (schema ${STATE_SCHEMA_FILE})\x1b[0m`);
  log(`\x1b[36m  a turn is assembled only when a wake ASSIGNS it a card — the kickoff and every pulse run the transcript path, and each turn says which one it took\x1b[0m`);
  return true;
})();

// #7060: the one place a turn decides whether it is a state step and the one place a skip is
// spoken. Speaks on CHANGE, not repetition; assembling a turn clears the memory so the next skip speaks.
let spokenStateSkip = null;
const stateSkip = (kind, card = 0) => {
  const why = stateSkipReason({ mode: STATE_MODE, kind, breakerTripped, card });
  if (STATE_MODE && why && why !== spokenStateSkip) log(`\x1b[33mTrantor State: this turn is NOT assembled — ${why}\x1b[0m`);
  spokenStateSkip = why;
  return why;
};

// The PREAMBLE, and it is the whole cost claim in one constant: the bytes before STATE_DELIM must
// be identical on every step or provider prefix caching never engages and the curve stays O(T).
// So it is computed ONCE, from things that do not vary per turn — no clock, no turn number, no
// wake text. Everything that changes rides in the state block, the card log, or the observation.
const STATE_PREAMBLE = `You are running on Trantor State. Your working memory for this card is the STATE block below — it is carried for you, so you do not have to re-read the conversation or the worktree to know where you are.

Answer with ONE JSON object matching the schema you were given: { "patch": Op[], "action": Action }.

  { "set":    { "field": "task"|"notes"|"ext.<key>", "value": ... } }
  { "add":    { "list": "done"|"in_flight"|"next"|"blockers", "item": { "id", "text", "paths"? } } }
  { "remove": { "list": ..., "id": ... } }
  { "move":   { "id": ..., "from": ..., "to": ... } }

action is exactly one of { "done": true } (the card is finished), { "ask": "<question>" }, or { "continue": true } (you did real work this step and are not finished).

Rules the harness enforces, so that you do not have to guess at them:
  · verify, files, cursor, rev, card and the counters are HARNESS-WRITTEN. A patch touching them is rejected.
  · An item may only reach "done" with evidence. Cite the files it rests on inline — "wire the promoter @lib/x.mjs,test/test-x.mjs" — and the harness runs the gate for you. A red gate hands you the failing assertion as your next observation; it does not mark your work done and it does not mark it failed.
  · Do the actual work with your own tools during this step. The patch describes what you did; it is not a plan.

${RULES}`;

// The card log the state block is read against (§4.1's `tail`). One board read per step, the same
// call hooks/lib/handoff.mjs already makes.
async function cardTail(card) {
  try {
    const r = await api(`/tasks?project=${encodeURIComponent(PROJ)}`);
    return renderCardTail(Array.isArray(r?.tasks) ? r.tasks : r, card);
  } catch { return ""; }
}

// The patch-outcome ledger the breaker reads back. Kept in memory for this runner AND appended to
// disk by the driver, because the breaker is a per-seat rolling window and a runner restart should
// not hand a misbehaving seat a clean slate it did not earn.
let patchLedger = [];
let breakerTripped = false;
let statePromotedHash;

// ---- the time box (#6134) --------------------------------------------------------------------
// TRANTOR_TURN_MAX_MS ends the CLI's process group at the box and runs ONE follow-up turn in the
// same session ("commit what is done, move the card, report") so a cut turn lands its work.
const TURN_MAX_MS = Math.max(0, Number(process.env.TRANTOR_TURN_MAX_MS || 20 * 60 * 1000));
const TIME_BOX_PROMPT = "your previous turn was cut at the time box; commit what is done, move the card with a note, report in one line";
let inFollowUp = false;
// #6289: whether the turn that just ended was CUT at the time box. The follow-up recursion
// overwrites it with its own state, so a caller reading it after the chain sees the state of the
// LAST turn — which is what decides whether a failed chain died to the box or to the API.
let lastTurnCut = false;
// The card the CURRENT CLI session belongs to (#6134). 0 = the kickoff session, which belongs to
// no card, so the first contract that names one starts a session of its own.
let sessionCard = 0;

let sid = "";
// #6206: the watchdog is DETACHED, so a runner that dies without ending it leaves an orphan
// sleeping toward a false alarm against whatever runner comes next.
// Every exit path therefore kills it, and the stamp carries this runner's instance id so any
// survivor that outlives the kill still refuses to speak for a runner it never belonged to.
const RUNNER_ID = `${process.pid}.${Date.now()}`;
let WD_CHILD = null;
function killWatchdog() { if (WD_CHILD) { try { WD_CHILD.kill("SIGTERM"); } catch {} WD_CHILD = null; } }
process.on("exit", killWatchdog);

// #6969: `opts.state` is the ONLY way this function behaves differently, and it is set from one
// place (stateTurn). With it unset every line below is the path that shipped before Phase 2a.
let lastEnvelope = "";
async function runTurn(prompt, isFirst, trigger = "kickoff", opts = {}) {
  TURN++; banner(trigger);
  lastEnvelope = "";
  const t0 = Date.now();
  // A fresh session must not resume the old one's id: `first` is chosen by isFirst OR a missing
  // sid, so a stale sid would quietly resume the session this turn exists to leave behind.
  if (isFirst) sid = "";
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
  // #6154: a pinned seat with no sid yet resumes as FRESH — the guard below fails open, because
  // a resume without an id must fall back to a new session, never to `next`'s bare resume shape.
  let cmd = (isFirst || ((cli.sid || cli.pinned) && !sid)) ? cli.first : cli.next;
  // The flagged row (TDD §4.6). `{S}` exists only in `stateNext`, so the replaceAll below is a
  // no-op on every other path — which is what "flag off = byte-identical" has to mean.
  if (opts.state && cli.stateNext) cmd = cli.stateNext;
  const mfrag = MODEL && cli.mflag ? `${cli.mflag}${MODEL}` : "";
  cmd = cmd.replaceAll("{M}", mfrag).replaceAll("{P}", pf).replaceAll("{SID}", sid).replaceAll("{DIR}", TURN_DIR)
    .replaceAll("{S}", STATE_SCHEMA_FILE);
  // PRECEDENCE: each file is PREPENDED, so the list is iterated in written order, highest priority
  // first, and the CREW layer (~/.agent-bus/.env) wins. test-crew-env.mjs runs the real shell.
  const envs = [join(homedir(), ".agent-bus", ".env"), cli.env].filter(f => f && existsSync(f));
  cmd = withEnvFiles(cmd, envs);
  log(`turn starting (${isFirst ? "fresh session" : "resume"})${MODEL ? ` · model=${MODEL}` : ""}`);
  cmuxStatus("building", "#4a90d9", "hammer", { priority: 50 }); herdrAgent("working");
  // inherit stdio so the window shows the agent working live; also capture for sid-parsing.
  // Tee stderr to ERRF (still shown live in the window) so a failed turn can be classified.
  try { appendFileSync(ERRF, "", { flag: "w" }); } catch {}   // truncate
  lastEmptyOutput = false;
  // pipefail so a failed CLI behind `| tee` still exits non-zero. Every stream lands in ERRF via
  // lib/redact.mjs (#5869, redacted bytes only); the tee topology is load-bearing (#5481).
  const SCRUB = `node ${join(import.meta.dirname, "..", "lib", "redact.mjs")}`;
  // §4.6 names a real cost of `--output-format json`: the seat's window would print a JSON blob
  // instead of prose, and the operator watches that window. So on a state step stdout goes to a
  // file and the runner prints the result line and the cost line itself. stderr still streams to
  // the window through the process substitution below, unchanged.
  const ENVF = join(homedir(), ".agent-bus", `envelope-${AGENT}-${PROJ}.json`);
  if (opts.state) { try { unlinkSync(ENVF); } catch {} }
  const inner = opts.state
    ? `${cmd} > ${ENVF}`
    : (cli.sid ? `${cmd} | tee /dev/stderr` : `${cmd} | ${SCRUB} --tee ${ERRF}`);
  // #5684: runTurn is spawnSync, so a DETACHED watchdog (stamp-armed) watches the turn and sends
  // ONE stall report, never a kill. #6206: floor 10 min, never derived from TRANTOR_TURN_MAX_MS.
  const WD_MS = Number(process.env.TRANTOR_TURN_WATCHDOG_MS) || 10 * 60 * 1000;
  const STAMPF = join(homedir(), ".agent-bus", `turnstamp-${AGENT}-${PROJ}.json`);
  // #6206: the CLI's transcript dir (a missing dir is a quiet channel), exported so a drill's fake
  // CLI can write lines the watchdog sees. CUTF is written by the shell's time box: cut, not crashed.
  const CUTF = join(homedir(), ".agent-bus", `turncut-${AGENT}-${PROJ}`);
  try { unlinkSync(CUTF); } catch {}
  // Touched by the stderr scrubber as its LAST act (the shell below); node waits for it after
  // spawnSync before reading ERRF — see the drain note at the spawnSync call.
  const DRAINF = join(homedir(), ".agent-bus", `turndrain-${AGENT}-${PROJ}`);
  try { unlinkSync(DRAINF); } catch {}
  try {
    writeFileSync(STAMPF, JSON.stringify({ turn: TURN, startedAt: Date.now(), runner: RUNNER_ID }));
    const wd = spawn(process.execPath, [join(import.meta.dirname, "turn-watchdog.mjs"), STAMPF, ERRF, String(WD_MS), SESSION, PROJ, HUB, TRANSCRIPT_DIR, TURN_DIR],
      { detached: true, stdio: "ignore" });
    WD_CHILD = wd;
    wd.unref();
  } catch {}
  // #6134: the box fires from INSIDE the shell, walking its own descendants bottom-up with `pgrep -P`
  // (setsid escapes a group signal, never its parent). The marker file tells node "cut", not "crashed".
  const sweep = `sweep() { local p; for p in $(pgrep -P $1 2>/dev/null); do sweep $p; done; kill -KILL $1 2>/dev/null; }`;
  const box = TURN_MAX_MS ? `
${sweep}
( sleep ${Math.ceil(TURN_MAX_MS / 1000)}
  kill -0 $job 2>/dev/null || exit 0
  : > ${CUTF}
  sweep $job
) & boxpid=$!` : "boxpid=";
  const shell = `set -o pipefail
{ ${inner} ; } 2> >(${SCRUB} --tee2 ${ERRF}; : >> "${DRAINF}") &
job=$!${box}
wait $job; turn_exit=$?
[ -n "$boxpid" ] && kill $boxpid 2>/dev/null
wait
exit $turn_exit`;
  const spawnOpts = {
    // detached: bash leads its own process group so the box can kill the CLI and everything it
    // spawned. stdin is /dev/null: a background group that reads the terminal stops on SIGTTIN.
    detached: true,
    cwd: TURN_DIR, encoding: "utf8", stdio: cli.sid ? ["ignore", "pipe", "inherit"] : ["ignore", "inherit", "inherit"],
    env: { ...process.env, RELAY_URL: HUB, RELAY_AGENT: AGENT, RELAY_SESSION: SESSION, RELAY_PROJECT: PROJ,
      // #6228: marks this env as belonging to PROJ, unlike a one-off RELAY_PROJECT override; crew.mjs's
      // `up` guard refuses to bring up another project's crew from a shell carrying this badge.
      TRANTOR_SEAT: PROJ,
      // A runner-managed seat must never hand itself a baton: the runner is its lifecycle manager,
      // so a handoff spawn would only leak an unmanaged interactive window.
      TRANTOR_NO_HANDOFF_SPAWN: "1", TRANTOR_NO_BATON_SPAWN: "1",
      // #6206: the seat's transcript dir — a real CLI ignores it, a drill's fake CLI writes
      // its transcript lines there so the watchdog sees the liveness a real claude shows.
      TRANTOR_TRANSCRIPT_DIR: TRANSCRIPT_DIR },
    maxBuffer: 16 * 1024 * 1024,
  };
  // A BACKSTOP only, deliberately later than the shell's own box: if bash itself wedges, node
  // still ends the turn. When the in-shell box works — the normal path — this never fires, which
  // is the point: the shell kills while the tree is still walkable, node cannot.
  if (TURN_MAX_MS) { spawnOpts.timeout = TURN_MAX_MS + 30000; spawnOpts.killSignal = "SIGKILL"; }
  const r = spawnSync("/bin/bash", ["-c", shell], spawnOpts);
  // The shell's box leaves the marker; the backstop leaves an ETIMEDOUT. Either way the turn was
  // cut, not merely failed.
  const boxed = existsSync(CUTF);
  const cut = !!TURN_MAX_MS && (boxed || r.error?.code === "ETIMEDOUT");
  // DRAIN before classifying, never on a CUT turn (the sweep killed the scrubber, its marker never
  // comes). bash 3.2 `wait` skips process substitutions, so wait for DRAINF, bounded.
  if (!cut) {
    const drainStart = Date.now();
    while (!existsSync(DRAINF) && Date.now() - drainStart < 3000) await new Promise(s => setTimeout(s, 50));
  }
  try { unlinkSync(DRAINF); } catch {}
  killWatchdog();                        // #6206: turn over — the watchdog dies NOW, it does not sleep on
  try { unlinkSync(STAMPF); } catch {}   // disarm any survivor: the stamp is gone
  if (cut) {
    // Belt and braces after the shell's descendant sweep: anything still sharing the turn's group.
    if (r.pid) { try { process.kill(-r.pid, "SIGKILL"); } catch {} }
    try { unlinkSync(CUTF); } catch {}
    log(`\x1b[33mturn cut at the ${Math.round(TURN_MAX_MS / 1000)}s time box — CLI and every descendant ended${boxed ? "" : " (node backstop: bash itself was wedged)"}\x1b[0m`);
  }
  lastTurnCut = cut;
  // #5869: scrub AT REST, synchronously, before anything reads the file back. The explicit shell
  // wait above drains the live stderr scrubber first; this pass is defense in depth for redaction.
  try { writeFileSync(ERRF, redactKeys(readFileSync(ERRF, "utf8"))); } catch {}
  // #5868: classify only what the CLI itself said. The transcript replays the whole turn prompt
  // (rules, lessons, the wake text) — and those lines once classified healthy codex turns as
  // auth ("…is forbidden.") and exhausted ("retries burn quota"). Prompt lines are stripped
  // before anything downstream looks at the text.
  let ownOut = "";
  try { ownOut = stripPromptEcho(readFileSync(ERRF, "utf8"), readPromptText(pf)); } catch { ownOut = ""; }
  lastErrText = ownOut.slice(-4000);
  if (opts.state) {
    try { lastEnvelope = redactKeys(readFileSync(ENVF, "utf8")); } catch { lastEnvelope = ""; }
    const env = parseEnvelope(lastEnvelope);
    if (env.turn) log(`state step: ${describeTurn(env.turn)} · ${costLine(env.cost)}`);
    else log(`\x1b[33mstate step: no TurnResult — ${env.error}\x1b[0m`);
  }
  if (cli.sid && r.stdout) { const m = r.stdout.match(cli.sid); if (m) sid = m[1]; }
  // #6154: the opencode family prints no sid on stdout — the id comes from opencode's own DB,
  // keyed by the worktree the session was created in. Fail-open: nothing found leaves sid empty,
  // and the next turn starts fresh rather than resuming whatever other project ran last.
  if (cli.pinned) { const found = ocSid(TURN_DIR); if (found) sid = found; }
  const realExit = r.status;
  // A zero exit is not proof the turn ran (#5405): an exit-0 auth turn is FAILED when the CLI's own
  // output is short enough to be just the error (#5868). Telemetry keeps the real exit.
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
  // #5481: exit 0 with an empty ERRF (the TOTAL capture, both streams) is the null-completion trap,
  // judged on echo-stripped text (#5868). #6969: on a state step ERRF is stderr only, so silence is normal.
  if (realExit === 0 && effExit === 0 && !lastErrText.trim() && !lastEnvelope.trim()) {
    effExit = 1;
    lastEmptyOutput = true;
    log("\x1b[31mexit 0 but the turn produced NO output — treating as FAILED (empty-output)\x1b[0m");
  }
  // #5868: the verdict rides the telemetry row so a classification survives the pane scrolling
  // away — the same "classified X because Y" shape the runner logs, in the seat's jsonl forever.
  const verdict = verdictFor(realExit, effExit, lastEmptyOutput, ownOut);
  // #6134: what the turn COST, from the CLI's own usage line. Zero means this CLI printed none —
  // never that the turn was free. `trantor seat-why` totals these into today's spend per seat.
  let tokens = parseTurnTokens(ownOut);
  if (opts.state && lastEnvelope) {
    const c = parseEnvelope(lastEnvelope).cost;
    // 0 means "this CLI printed no usage", never "free" — so only overwrite when the envelope
    // actually carried counts.
    if (c) tokens = c.input + c.output + c.cache_read + c.cache_creation;
  }
  // #6289: every ledger row names in ONE field what happened to the turn — cut (the box ended it),
  // api-error (the CLI failed), completed — and what it cost in tokens, even when this CLI printed
  // no usage line (0 means "not reported", never "free"). `cut` stays too: the drills read it.
  const outcome = cut ? "cut" : (effExit !== 0 ? "api-error" : "completed");
  const telemetryRow = { ts: Date.now(), agent: AGENT, project: PROJ, turn: TURN, trigger, model: MODEL || "cli-default", duration_ms: Date.now() - t0, exit: realExit, effExit, authFailed: effExit !== realExit, emptyOutput: lastEmptyOutput, verdict, outcome, tokens };
  if (cut) telemetryRow.cut = true;
  telemetry(telemetryRow);
  log(`turn ended (exit ${realExit}${effExit !== realExit ? ` → effective ${effExit} (${lastEmptyOutput ? "empty-output" : "auth"})` : ""}, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  if (realExit === 0 && effExit === 0) { cmuxStatus("idle", "#8a94a6", "robot"); herdrAgent("idle"); }   // finished this turn, waiting for the next
  // #5965 — TURN END. A clean exit means the seat is idle again; say so right away so the app stops
  // pulsing it even before the next /poll heartbeat. Failure keeps reportFailure's down/errored.
  if (realExit === 0 && effExit === 0) await registerStatus("idle");
  // The follow-up rides the SAME session, exactly once. A state step gets none: TIME_BOX_PROMPT
  // would break the byte-identical prefix, and §4.4 says a cut turn never partially applied a patch.
  if (cut && !inFollowUp && !opts.state) {
    inFollowUp = true;
    try { return await runTurn(TIME_BOX_PROMPT, false, "time-box follow-up"); }
    finally { inFollowUp = false; }
  }
  return effExit;
}

// What the NEXT state step opens with when the last one was rejected (§4.8: the seat's next step
// begins with the actual failing assertion). Cleared on every accepted patch.
let stateObservation = "";

// ---- Phase 2a: one state step, driven by lib/state/driver.mjs -------------------------------
// The runner is transport and side effects; the driver holds the §4.1 order. Returns an exit code
// so deliverWake's success/failure ladder is untouched.
async function stateTurn({ card, observation, trigger, assigners = [] }) {
  const tail = await cardTail(card);
  const r = await runStep({
    seat: SESSION, card, project: PROJ, cwd: TURN_DIR,
    preamble: STATE_PREAMBLE, tail, observation,
    promoted: statePromotedHash,
    now: Date.now(),
    deps: {
      callCli: async (prompt) => {
        // isFirst=true every step ON PURPOSE: a state step carries no `-c`, so there is no session
        // to resume and a stale sid must never be handed to one.
        const exit = await runTurn(prompt, true, trigger, { state: true });
        return { exit, stdout: lastEnvelope, cut: lastTurnCut };
      },
      executeAction: async (action) => {
        // `ask` is the one action with an outside effect. State does NOT move cards (§4.7) — the
        // seat calls relay_task_move itself — so `done` and `continue` are recorded and nothing else.
        const ask = String(action?.ask ?? "").trim();
        if (ask) await notifyAssigners(assigners, `❓ ${SESSION} asks on #${card}: ${ask}`);
      },
    },
  });

  statePromotedHash = r.promoted;
  if (r.patchRecord) patchLedger.push(r.patchRecord);

  // §7.3's breaker: a seat whose rolling MALFORMED rate is over budget goes back to the transcript
  // path, and the room is told ONCE. Never repeated — a warning repeated every turn is the thing
  // the monitoring doctrine calls noise, and the condition is a state, not an event.
  if (!breakerTripped) {
    const v = breakerVerdict(patchLedger, SESSION, { window: BREAKER_WINDOW });
    if (v.tripped) {
      breakerTripped = true;
      log(`\x1b[31mstate-mode CIRCUIT BREAKER tripped — ${v.message}; falling back to the transcript path\x1b[0m`);
      await api("/send", {
        from: SESSION, to: "all", project: PROJ, kind: "status",
        text: `⚠️ ${SESSION} left Trantor State: ${v.message} (TDD §7.3 breaker) — back on the transcript path`,
      }).catch(() => {});
    }
  }

  if (!r.ok) {
    // A rejection is NOT a failed turn. The patch was refused, the state is untouched, and the
    // rejection is the next step's observation — which is the loop working, not the seat dying.
    // Only the transport's own exit decides the runner's ladder, and a rejected patch on an exit-0
    // CLI is an exit-0 turn.
    log(`state step rejected (${r.code}): ${String(r.message).slice(0, 200)}`);
    stateObservation = r.observation;
    return r.step && r.step.exit ? r.step.exit : 0;
  }
  stateObservation = "";
  return 0;
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

// #5683: every prompt section is capped (bin/crew-payload.mjs) and the payload has ONE hard total
// cap; below the caps the composition is byte-identical to the old concatenation.
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

// A hub staleness alert describes a moment, so it EXPIRES; a peer's message never does, because a
// seat missing a teammate's request is the failure this bus exists to prevent.
const HUB_ALERT_TTL_MS = Number(process.env.TRANTOR_HUB_ALERT_TTL_MS || 30 * 60_000);
const isExpiredHubAlert = (m) =>
  m?.from === "hub:duty" &&
  Number.isFinite(m?.ts) &&
  Date.now() - m.ts > HUB_ALERT_TTL_MS;

function shouldWake(message) {
  if (isExpiredHubAlert(message)) return false;
  if (isReceipt(message) || isStatusBroadcast(message)) return false;
  // #6134: the SENDER decides. `wake:false` says "this is context, not a contract" — it batches
  // into the next turn's prompt like a broadcast and never buys a CLI session of its own.
  if (message?.wake === false) return false;
  if (message?.to === SESSION) {
    if (message?.kind === "status") return false;
    // Safety net for senders that never set the flag: a direct message carrying no card and no
    // instruction is context. Typed alerts and overseer warnings still wake (#5760).
    const typed = message?.kind === "alert" || /^🤝 OVERSEER /.test(String(message?.text || ""));
    if (!typed && !isContract(message) && !carriesWork(message?.text)) return false;
    return !isRunnerSession(message?.from) || isContract(message);
  }
  return message?.to === "all"
    && isContract(message)
    && (message.text.includes(`@${AGENT}`) || message.text.toLowerCase().includes(`${AGENT}:`));
}

// #6228: the operator's declared project links, cached briefly so a burst of wakes doesn't hit
// /policy per message. Fails CLOSED on an unreachable hub (keeps whatever was last known, empty
// on a cold start) — the mechanical fence the hub enforces at write time must not go soft just
// because the read-side cache call happened to miss.
let linksCache = { at: 0, links: [] };
async function currentLinks() {
  if (Date.now() - linksCache.at < 60000) return linksCache.links;
  try {
    const r = await api("/policy");
    linksCache = { at: Date.now(), links: Array.isArray(r?.links) ? r.links : [] };
  } catch {}
  return linksCache.links;
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
  // Announce runner-side, signed as THIS seat: the runner process is per-seat by construction, so
  // its signature cannot be borrowed the way a shared opencode MCP daemon once borrowed identities.
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
  // Say what the restore SHED, not just what it kept. A queue that quietly halves itself on restart
  // is indistinguishable from one that lost real work, and this is the moment the expiry above
  // actually bites — a wedged seat comes back carrying only what still means something.
  const shed = restored.wake.filter(isExpiredHubAlert).length +
               restored.bcast.filter(isExpiredHubAlert).length;
  let pendingWake = restored.wake.filter(shouldWake);
  let pendingBcast = restored.bcast.filter(m => !isExpiredHubAlert(m) && !isReceipt(m) && !isStatusBroadcast(m));
  if (shed) {
    log(`\x1b[33mdropped ${shed} expired hub staleness alert(s) older than ${Math.round(HUB_ALERT_TTL_MS / 60000)}m — they describe conditions that have long since changed\x1b[0m`);
    // Persist the shed queue NOW: `trantor duty status` reads the FILE, and disk and memory
    // disagreeing makes a health check lie.
    savePending(pendingWake, pendingBcast);
  }
  let retryAt = 0;            // 0 = deliver at the next opportunity
  let deliveryFails = 0;      // consecutive failed attempts at the SAME pending batch
  if (pendingWake.length) log(`\x1b[33m${pendingWake.length} message(s) survived from a previous run — redelivering\x1b[0m`);

  // #7060: the turn the boot line was read as a promise about. It is a transcript turn by
  // construction and now says so, in the same breath as the line that armed the mode.
  stateSkip("kickoff");
  const ec0 = await runTurn(composedTurn({ base: KICKOFF, lessons: pickLessons(LESSONS_RAW, "") }), true, "kickoff");
  if (ec0) await reportFailure(ec0, "kickoff", pendingWake.length);   // a failed kickoff = the "fired up, died, nobody knew" case
  let lastTurnAt = Date.now();
  if (PULSE_MS) log(`pulse armed — mission re-read every ${Math.round(PULSE_MS / 1000)}s (${MISSION_FILE})`);
  log(`parked — long-polling the bus as ${SESSION} (free; this poll is also the heartbeat)`);

  while (true) {
    // pulse first: a due mission beat runs even on a silent bus. Measured from the END of the
    // last turn, so a long turn doesn't stack an immediate pulse on top of itself.
    if (PULSE_MS && Date.now() - lastTurnAt >= PULSE_MS) {
      stateSkip("pulse");
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
    // #5760: the hub's hourly same-project-sessions FYI is coordination context, batched like a
    // broadcast; file-conflict and linked-activity overseer warnings still wake.
    const fyi = msgs.filter(m => m.from === "hub:duty" && String(m.text || "").startsWith("🤝 OVERSEER same-project-sessions"));
    const rest = msgs.filter(m => !fyi.includes(m));
    const direct = rest.filter(m => m.to === SESSION && shouldWake(m));
    const mentions = rest.filter(m => m.to === "all" && shouldWake(m));
    // Everything that did not earn a turn still becomes CONTEXT — including a DIRECT message that
    // batched (wake:false, or an ack by shape). Dropping those would trade a token problem for a
    // deafness problem: the seat would never learn what it was told (#6134).
    const bcast = [...rest.filter(m => !direct.includes(m) && !mentions.includes(m)), ...fyi];
    pendingBcast.push(...bcast);                      // wake-policy: plain broadcasts batch, they don't wake
    const wakeCandidates = [...direct, ...mentions];
    // #6228: a wake naming an unlinked foreign project is dropped, with one report to the sender.
    // The hub's own agents (`hub:duty` et al.) are exempt: they speak for this hub's projects (#6301).
    const links = wakeCandidates.length ? await currentLinks() : [];
    const crossProject = wakeCandidates.filter(m => !String(m.from || "").startsWith("hub:") && !isLinkedProject(senderProjectOf(m.from), PROJ, links));
    for (const m of crossProject) {
      const sp = senderProjectOf(m.from) || "?";
      log(`\x1b[33mcross-project wake dropped\x1b[0m — ${m.from} (${sp}) is not ${PROJ}'s project and the two are not linked`);
      api("/send", { from: SESSION, to: m.from, project: sp, kind: "status",
        text: `⛔ cross-project: ${SESSION} is ${PROJ}'s seat, not ${sp}'s — dropped without acting. Link them first: trantor policy link ${PROJ} ${sp} --reason "<why>"` }).catch(() => {});
    }
    const wake = wakeCandidates.filter(m => !crossProject.includes(m));
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
    const dutyPlan = DUTY_NUDGES
      ? await claimDutyNudges({
        messages: wake,
        statePath: DUTY_NUDGE_STATE,
        owner: `${RUNNER_ID}:${TURN + 1}`,
        // /peer (singular) is the only endpoint that serialises deliveredUpTo; the cursor is monotonic,
        // so `>= id` means handed over. Best-effort: a missed nudge is worse than a redundant one.
        isDelivered: async ({ id, recipient }) => {
          if (!recipient || !/^\d+$/.test(String(id))) return false;
          const r = await api(`/peer?session=${encodeURIComponent(recipient)}`).catch(() => null);
          const upTo = Number(r?.deliveredUpTo || 0);
          return upTo > 0 && upTo >= Number(id);
        },
      })
      : { items: [], targets: [], owner: "" };
    const claimedIds = new Set(dutyPlan.items.map(item => item.id));
    const wakeForTurn = DUTY_NUDGES
      ? wake.filter(message => {
        const escalation = dutyEscalations([message])[0];
        return !escalation || claimedIds.has(escalation.id);
      })
      : wake;
    if (!wakeForTurn.length) {
      pendingWake = [];
      savePending([], pendingBcast);
      log("duty escalation already nudged or reserved by another turn — consumed without a duplicate model wake");
      return;
    }
    const wakeCapped = capWake(wakeForTurn);
    const bcastCapped = capBcast(pendingBcast);
    const wakeText = wakeCapped.text
      ? `NEW BUS MESSAGE${wakeForTurn.length > 1 ? "S" : ""} for you:\n${wakeCapped.text}\n`
      : "";
    const ctxText = bcastCapped.text
      ? `\nFYI broadcasts since your last turn (context only):\n${bcastCapped.text}\n`
      : "";
    // Say plainly that this is a second look. Without it the model re-reads an old escalation as
    // brand new and can redo work it already half-did before the turn died.
    const againText = deliveryFails
      ? `\n(REDELIVERY, attempt ${deliveryFails + 1} — an earlier turn failed before acting on ${wakeForTurn.length > 1 ? "these" : "this"}. Check what you already did before repeating it.)\n`
      : "";
    await loadLessons();
    const lessons = pickLessons(LESSONS_RAW, wakeCapped.text + " " + bcastCapped.text);
    const trigger = wakeForTurn.some(m => m.to === SESSION) ? "direct message" : "@mention";
    // Who is owed an answer, captured BEFORE the turn: pendingWake is cleared on success.
    const assigners = [];
    for (const m of wakeForTurn) if (m.from && !assigners.some(a => a.from === m.from)) assigners.push({ from: m.from, id: m.id });
    const asked = askedExcerpt(wakeForTurn[0]);
    const tStart = Date.now();
    // #6134: ONE SESSION PER CARD; a different card starts a fresh CLI session and the seat is told.
    // #7061: bound by SHAPE, not position, so an order opening with what shipped binds the right card.
    const card = wakeCard(wakeForTurn, { session: SESSION });
    const fresh = card > 0 && card !== sessionCard;
    if (card) sessionCard = card;
    const cited = [...new Set(wakeForTurn.flatMap(m => cardRefs(m.text)))];
    const freshText = fresh
      ? `\n(FRESH SESSION for card #${card} — you are not the session that worked earlier cards and you remember none of them. Read your card first: relay_board with card:${card}.)\n`
      // A wake naming several cards used to leave the seat guessing which one the machine believed
      // — the prompt named two and committed to neither. Say it, even when the session continues.
      : (card && cited.length > 1
        ? `\n(This turn is card #${card} — the wake cites ${cited.length} cards; the rest are context.)\n`
        : "");
    const prompt = composedTurn({
      wakeText, ctxText, againText: againText + freshText + dutyNudgeDirective(dutyPlan),
      tailText: "\nAct on what's addressed to you, then end your turn.\n\n",
      rulesText: RULES, lessons,
    });
    const stopDutyNudgeWatcher = startDutyNudgeWatcher(dutyPlan, tStart);
    let ec;
    const stateStep = !stateSkip("wake", card);
    try {
      ec = stateStep
        ? await stateTurn({
          card, trigger: deliveryFails ? `${trigger} (redelivery)` : trigger, assigners,
          // The observation is everything that CHANGED since the last step — the wake, the
          // broadcasts, the redelivery note, and any rejection the last step earned. None of it
          // may reach the preamble, or the prefix stops being byte-identical and the cache claim
          // dies quietly (§4.6).
          observation: [stateObservation, wakeText, ctxText, againText + freshText].filter(Boolean).join("\n"),
        })
        : await runTurn(prompt, fresh, deliveryFails ? `${trigger} (redelivery)` : trigger);
    }
    finally { stopDutyNudgeWatcher(); }
    const secs = Math.round((Date.now() - tStart) / 1000);
    let skippedNudges = [];
    if (!ec && dutyPlan.items.length) {
      const observedIds = observedDutyNudgeIds(TRANSCRIPT_DIR, tStart);
      const audit = await auditDutyNudges({
        plan: dutyPlan,
        observedIds,
        statePath: DUTY_NUDGE_STATE,
        reportFailure: async target => {
          const ids = target.ids.map(id => `#${id}`).join(", ");
          await api("/duty/failure", {
            recipient: target.recipient,
            project: target.project,
            kind: "skipped-nudge",
            detail: `duty turn ended without a SendMessage socket nudge for new undelivered ids ${ids}`,
          }).catch(() => {});
        },
      });
      skippedNudges = audit.missing;
    }
    if (!ec && skippedNudges.length) {
      deliveryFails++;
      savePending(pendingWake, pendingBcast);
      const wait = RETRY_MS[Math.min(deliveryFails - 1, RETRY_MS.length - 1)];
      retryAt = Date.now() + wait;
      const ids = skippedNudges.flatMap(target => target.ids).map(id => `#${id}`).join(", ");
      log(`\x1b[31mduty turn skipped mandatory socket nudge(s) ${ids} — recorded failure; retrying in ${Math.round(wait / 1000)}s\x1b[0m`);
      lastTurnAt = Date.now();
      return;
    }
    if (ec) {
      deliveryFails++;
      // #6131: a silent turn on a seat whose plan reads spent is exhaustion wearing a crash's
      // clothes. Only that one reason is ever re-read, and only from the seat's own balance rows.
      let reason = classify(ec);
      let quotaReset = 0;
      if (reason === "empty-output") {
        const rows = await balanceRows();
        reason = reasonWithBalances(reason, rows);
        // The rows that just proved the plan is spent also carry when it lifts — a park that names
        // the reset is a wait, a park that cannot is a seat the operator has to remember by hand.
        if (reason === "exhausted") quotaReset = quotaResetAt(rows);
      }
      savePending(pendingWake, pendingBcast);
      await reportFailure(ec, "message", pendingWake.length, reason);
      // #6289: TWO consecutive exit-1 turns on one contract PARK the seat (time-box when the chain
      // died to cuts, api-error otherwise), holding the queue until `trantor up`.
      const parkReason = PARKING_REASONS.has(reason) ? reason : (lastTurnCut ? "time-box" : "api-error");
      if (PARKING_REASONS.has(reason) || deliveryFails >= 2) {
        retryAt = await parkSeat(parkReason, pendingWake.length, quotaReset);
        // RUNNER_PARK_MAX_MS is set only by `trantor duty up` (launchd keepalive): past the ceiling,
        // exit so the supervisor restarts clean. Unsupervised seats stay parked; exiting would kill them.
        const parkMax = Number(process.env.RUNNER_PARK_MAX_MS || 0);
        if (parkMax > 0) {
          const wakeIn = Math.max(0, Math.min(retryAt - Date.now(), parkMax));
          log(`\x1b[33msupervised seat: exiting in ${Math.round(wakeIn / 1000)}s so the keepalive restarts it clean\x1b[0m`);
          setTimeout(() => {
            log("parked past the ceiling — exiting for the keepalive to relaunch");
            process.exit(0);   // 0, not 1: this is a deliberate hand-off, not a crash
          }, wakeIn).unref?.();
        }
        await notifyAssigners(assigners,
          `⛔ your contract is PARKED on ${SESSION} (${parkReason}) — not retrying · asked: "${asked}"`);
        lastTurnAt = Date.now();
        return;
      }
      const wait = RETRY_MS[Math.min(deliveryFails - 1, RETRY_MS.length - 1)];
      retryAt = Date.now() + wait;
      // The room hears the broadcast above; the one who is actually blocked hears it directly.
      await notifyAssigners(assigners,
        `⚠️ your contract FAILED on ${SESSION} (exit ${ec}, ${reason}) · retrying in ${Math.round(wait / 1000)}s · asked: "${asked}"`);
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

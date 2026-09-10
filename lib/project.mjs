// trantor — canonical project identity (client side): one repo = one lane, keyed by the git repo
// root basename; an explicit RELAY_PROJECT always wins and the hub folds aliases on top.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join, dirname } from "node:path";
import { homedir, hostname } from "node:os";

export function gitRoot(dir) {
  try {
    return execSync(`git -C ${JSON.stringify(dir)} rev-parse --show-toplevel`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
  } catch { return ""; }
}

// Stable project key for a working directory. RELAY_PROJECT > git-root basename > cwd basename.
// The env comes in as a parameter (#6218): the handoff resolver must be able to resolve the cwd
// WITHOUT the shell's RELAY_PROJECT — a badge that lied about the cwd must not get a second
// voice through the fallback's own env read.
export function resolveProject(cwd = process.cwd(), env = process.env) {
  if (env.RELAY_PROJECT) return env.RELAY_PROJECT.slice(0, 80);
  const root = gitRoot(cwd);
  // A LINKED WORKTREE resolves to its MAIN repo's name: seat worktrees live under
  // ~/.agent-bus/worktrees/<project>/<agent>, so the basename rule named the project after the agent.
  if (root) {
    try {
      const common = execSync("git rev-parse --path-format=absolute --git-common-dir", {
        cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000,
      }).trim();
      if (common.endsWith("/.git")) return basename(dirname(common)).slice(0, 80);
    } catch {}
  }
  return basename(root || cwd).slice(0, 80);
}

// ── Per-project hub routing (TDD §12.1) ──────────────────────────────────────
// A project lives on exactly ONE hub: RELAY_URL env → config hubs[project] → legacy global `url`
// → local default. Never throws: hooks run inside the user's tool loop and must fail open.
export const DEFAULT_HUB_URL = "http://127.0.0.1:4477";

// The bus directory, resolved in ONE place. Both override names (AGENT_BUS_DIR, RELAY_DATA_DIR) are
// honoured: a reader that honours neither mutates the user's REAL state during a drill.
export function busDir() {
  return process.env.AGENT_BUS_DIR || process.env.RELAY_DATA_DIR || join(homedir(), ".agent-bus");
}
export function handoffDir() { return join(busDir(), "handoffs"); }
// The orchestrator-session map: which claude conversation IS this project's orchestrator thread, one
// TAB-separated row per project, shared with `trantor open`/`adopt` and updated across a handoff.
export function orchSessionsPath() { return join(busDir(), "orch-sessions.txt"); }
export function readOrchSession(project) {
  try {
    for (const line of readFileSync(orchSessionsPath(), "utf8").split("\n")) {
      const [p, sid] = line.split("\t");
      if (p === project && sid && sid.trim()) return sid.trim();
    }
  } catch {}
  return "";
}
// Is the session writing a handoff RIGHT NOW the orchestrator thread? Decided by evidence: TRANTOR_ORCH
// matching the project, else the recorded thread's transcript freshly written. Returns its id or "".
export function orchWriterSid(projectDir, project, { withinMs = 90_000, env = process.env, now = Date.now(), claudeProjectsDir = join(homedir(), ".claude", "projects") } = {}) {
  const sid = readOrchSession(project);
  if (!sid) return "";
  const badge = env.TRANTOR_ORCH || "";
  if (badge && (badge === "1" || badge === project)) return sid;
  try {
    const slug = String(projectDir).replace(/[/.]/g, "-");
    const t = join(claudeProjectsDir, slug, `${sid}.jsonl`);
    if (now - statSync(t).mtimeMs < withinMs) return sid;
  } catch {}
  return "";
}
export function writeOrchSession(project, sid, by = "unknown") {
  try {
    if (!project || !sid) return false;
    const p = orchSessionsPath();
    mkdirSync(dirname(p), { recursive: true });
    const rows = existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];
    const prev = rows.find(r => r.split("\t")[0] === project)?.split("\t")[1] || "";
    const kept = rows.filter(r => r.split("\t")[0] !== project);
    writeFileSync(p, [...kept, `${project}\t${sid}`].join("\n") + "\n");
    // Every rewrite leaves a row in the sibling log (SYSTEM-CONTRACT §4: the map has exactly
    // three writers, and a rewrite must be attributable after the fact). Local and append-only
    // on purpose: this runs inside hooks with no time for network, and the interesting rewrite
    // — a handoff claim — additionally becomes a bus event when the Phase 4 state machine lands.
    if (prev !== sid) {
      try {
        appendFileSync(join(busDir(), "orch-sessions.log"),
          `${new Date().toISOString()}\t${project}\t${prev || "-"}\t${sid}\t${by}\n`);
      } catch {}
    }
    return true;
  } catch { return false; }
}
function configPath() { return join(busDir(), "config.json"); }

export function readConfig() {
  try { const c = configPath(); if (existsSync(c)) { const j = JSON.parse(readFileSync(c, "utf8")); if (j && typeof j === "object") return j; } } catch {}
  return {};
}

// HOW a hub was chosen, not merely which one: the silent fallback to the global default is the most
// expensive failure here, so callers that can warn say WHY. via ∈ env | pin | global | default.
export function resolveHubInfo(project, env = process.env) {
  try {
    if (env.RELAY_URL) return { url: env.RELAY_URL, via: "env" };
    const cfg = readConfig();
    const name = project || resolveProject();
    const u = cfg?.hubs?.[name];
    if (u && typeof u === "string") return { url: u, via: "pin" };
    if (cfg?.url && typeof cfg.url === "string") return { url: cfg.url, via: "global" };
  } catch {}
  return { url: DEFAULT_HUB_URL, via: "default" };
}

export function resolveHub(project, env = process.env) {
  return resolveHubInfo(project, env).url;
}

// Every project the operator has deliberately pinned — the "expected one of these" list a
// misplaced session needs in order to fix itself.
export function knownProjects() {
  try { const h = readConfig()?.hubs; return h && typeof h === "object" ? Object.keys(h).sort() : []; } catch { return []; }
}

// How many IMMEDIATE children of `dir` are git repos. Bounded (first 200 entries) and fail-safe:
// this runs in every session start, inside the user's tool loop.
function countChildRepos(dir) {
  try {
    let n = 0;
    for (const e of readdirSync(dir, { withFileTypes: true }).slice(0, 200)) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      if (existsSync(join(dir, e.name, ".git"))) { n++; if (n >= 2) return n; }
    }
    return n;
  } catch { return 0; }
}

// Is this directory a real project seat, and if not, WHY not ("" for a seat)? A non-seat must never
// register: it mints a phantom board on the fallback hub while the crew lives on the pinned one.
export function nonSeatReason(dir = process.cwd(), env = process.env) {
  try {
    if (env.RELAY_SESSION || env.RELAY_PROJECT) return "";
    const home = homedir();
    if (dir === home) return "the home directory";
    const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
    if (dir.startsWith(join(claudeDir, "plugins", "cache"))) return "the plugin cache";
    // A WORKSPACE CONTAINER (~/development) is the worst case: it registers as project "development",
    // unpinned, on the fallback hub. A plain non-git directory is NOT disqualified.
    if (!gitRoot(dir) && countChildRepos(dir) >= 2) return "a folder of projects, not a project";
  } catch {}
  return "";
}

// Public writer for callers that own their own slice of config.json (lib/seats.mjs). Kept as a
// named export rather than exposing the internal one, so the file stays the single writer.
export function writeConfigPublic(cfg) { writeConfig(cfg); }

function writeConfig(cfg) {
  mkdirSync(busDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

// Pin a project to a hub. URL must be absolute http(s); trailing slash stripped so
// `${hub}/path` concatenation never double-slashes.
export function setProjectHub(project, url) {
  if (!project || typeof project !== "string") throw new Error("project required");
  if (!/^https?:\/\//.test(String(url || ""))) throw new Error("url must start with http:// or https://");
  const cfg = readConfig();
  cfg.hubs = { ...(cfg.hubs && typeof cfg.hubs === "object" ? cfg.hubs : {}), [project]: String(url).replace(/\/+$/, "") };
  writeConfig(cfg);
}

// Unpin a project (it falls back to the global `url`, then the local default). Returns whether
// a mapping existed.
export function unsetProjectHub(project) {
  const cfg = readConfig();
  if (!cfg.hubs || typeof cfg.hubs !== "object" || !(project in cfg.hubs)) return false;
  delete cfg.hubs[project];
  if (!Object.keys(cfg.hubs).length) delete cfg.hubs;
  writeConfig(cfg);
  return true;
}

// Stable machine identity: os.hostname() changes with the network and forks one Mac into two bus
// identities, so resolve once and persist to ~/.agent-bus/machine-id (docs/CONTRACT-lib.md §machine).
let _hostId = null;
// Wrap a command so it runs with the seat's provider keys loaded, highest-priority file FIRST: each
// file is prepended, so the last prepended runs first and the last run wins (proved by test-crew-env.mjs).
export function withEnvFiles(cmd, files = []) {
  let out = cmd;
  for (const f of files) if (f) out = `set -a; source ${f}; set +a; ${out}`;
  return out;
}

export function hostId() {
  if (_hostId) return _hostId;
  if (process.env.RELAY_HOST_ID) return (_hostId = process.env.RELAY_HOST_ID.slice(0, 60));
  const f = join(homedir(), ".agent-bus", "machine-id");
  try { if (existsSync(f)) { const v = readFileSync(f, "utf8").trim(); if (v) return (_hostId = v.slice(0, 60)); } } catch {}
  let id = "";
  if (process.platform === "darwin") {
    try { id = execSync("scutil --get LocalHostName", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1500 }).trim(); } catch {}
  }
  if (!id) id = String(hostname() || "host").split(".")[0];
  id = id.slice(0, 60) || "host";
  try { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, id); } catch {}
  return (_hostId = id);
}

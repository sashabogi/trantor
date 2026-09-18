// trantor — canonical project identity (client side): one repo = one lane, keyed by the id recorded
// in the checkout (.trantor/project.json) or, unmarked, by the git repo root basename; an explicit
// RELAY_PROJECT always wins and the hub folds aliases on top.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync, realpathSync } from "node:fs";
import { basename, join, dirname, resolve, sep } from "node:path";
import { homedir, hostname } from "node:os";

export function gitRoot(dir) {
  try {
    return execSync(`git -C ${JSON.stringify(dir)} rev-parse --show-toplevel`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
  } catch { return ""; }
}

// A BUS SEAT WORKTREE is named for its project BY CONSTRUCTION — the bus creates
// ~/.agent-bus/worktrees/<project>/<seat>. Trusting the path keeps a seat's relay MCP on its
// project's pin even when git cannot answer for the directory (#7893: a scrubbed-env MCP with no
// `git` on PATH named the project after the SEAT, missed the pin, and silently hit localhost).
export function worktreeProject(cwd, env = process.env) {
  try {
    const root = join(busDirFor(env), "worktrees");
    const dir = resolve(String(cwd));
    // Compare realpaths when both sides resolve: a spawned process reports its PHYSICAL cwd, and
    // macOS /tmp is a symlink (/var → /private/var), so raw prefix matching missed drills entirely.
    const real = (p) => { try { return realpathSync(p); } catch { return p; } };
    let rest = "";
    if (dir.startsWith(root + sep)) rest = dir.slice((root + sep).length);
    else if (real(dir).startsWith(real(root) + sep)) rest = real(dir).slice((real(root) + sep).length);
    else return "";
    const name = rest.split(sep)[0];
    return name && !name.startsWith(".") ? name.slice(0, 80) : "";
  } catch { return ""; }
}

// ── The project id marker (#6724): a directory rename used to rename the project and orphan its
// pin, board and sessions. The id lives IN the checkout (commit it), so a plain `mv` carries it. It
// is the bus name at claim time, not a token: hub, pins, boards, worktrees and session ids already
// key on that name. The directory basename is a label from here on.
export const PROJECT_MARKER = join(".trantor", "project.json");
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
export function isProjectId(id) { return PROJECT_ID.test(String(id ?? "")) && !String(id).includes(".."); }
export function projectMarkerPath(root) { return join(root, PROJECT_MARKER); }
// The id a checkout ROOT records, "" when unmarked or unreadable. Never throws: this runs in hooks.
export function readProjectId(root) {
  try {
    const id = JSON.parse(readFileSync(projectMarkerPath(root), "utf8"))?.id;
    return isProjectId(id) ? String(id) : "";
  } catch { return ""; }
}
// Claim an id for a checkout. Refuses a malformed id; the caller decides about overwriting.
export function writeProjectId(root, id, by = "trantor") {
  if (!isProjectId(id)) throw new Error(`project id "${id}" must be letters, digits, . _ - (80 max)`);
  const p = projectMarkerPath(root);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ id: String(id), since: new Date().toISOString().slice(0, 10), by }, null, 2) + "\n");
  return p;
}
// The marker that governs `cwd`: walk up to the first repo boundary (.git, dir or worktree file)
// and stop there, so a nested repo never inherits its parent's identity. No git binary needed —
// the scrubbed-env MCP of #7893 could not run git either.
export function markerProject(cwd) {
  let dir = resolve(String(cwd || "."));
  for (let depth = 0; depth < 64; depth++) {
    const id = readProjectId(dir);
    if (id) return id;
    if (existsSync(join(dir, ".git"))) return "";
    const up = dirname(dir);
    if (up === dir) return "";
    dir = up;
  }
  return "";
}

// Stable project key for a working directory WITH its provenance, via ∈ env | worktree | marker |
// git | basename, in that precedence. The env comes in as a parameter (#6218): the handoff resolver
// must resolve the cwd WITHOUT the shell's RELAY_PROJECT — a badge that lied about the cwd must not
// get a second voice through the fallback's own env read.
export function resolveProjectInfo(cwd = process.cwd(), env = process.env) {
  if (env.RELAY_PROJECT) return { project: env.RELAY_PROJECT.slice(0, 80), via: "env" };
  // The worktree path is deliberate evidence, stronger than git: the bus created that layout.
  const wt = worktreeProject(cwd, env);
  if (wt) return { project: wt, via: "worktree" };
  const marked = markerProject(cwd);
  if (marked) return { project: marked, via: "marker" };
  const root = gitRoot(cwd);
  // A LINKED WORKTREE resolves to its MAIN repo's name: seat worktrees live under
  // ~/.agent-bus/worktrees/<project>/<agent>, so the basename rule named the project after the agent.
  if (root) {
    try {
      const common = execSync("git rev-parse --path-format=absolute --git-common-dir", {
        cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000,
      }).trim();
      if (common.endsWith("/.git")) return { project: basename(dirname(common)).slice(0, 80), via: "git" };
    } catch {}
  }
  return { project: basename(root || cwd).slice(0, 80), via: root ? "git" : "basename" };
}
export function resolveProject(cwd = process.cwd(), env = process.env) {
  return resolveProjectInfo(cwd, env).project;
}

// Where projects live on THIS machine: ~/development by convention, TRANTOR_DEV_ROOT to relocate.
export function devRootFor(env = process.env) {
  return env.TRANTOR_DEV_ROOT || join(env.HOME || homedir(), "development");
}
// The checkout that carries project `id`, "" when none is here. <devRoot>/<id> when that directory
// exists and does not claim to be a different project; otherwise the immediate child whose marker
// says `id` — the renamed directory. Bounded to the first 200 entries; every caller ran
// `join(devRoot, id)` by hand before #6724, which is exactly the lookup a rename broke.
export function checkoutFor(id, env = process.env) {
  if (!isProjectId(id)) return "";
  const root = devRootFor(env);
  const direct = join(root, id);
  try {
    if (statSync(direct).isDirectory()) {
      const marked = readProjectId(direct);
      if (!marked || marked === id) return direct;
    }
  } catch {}
  try {
    for (const e of readdirSync(root, { withFileTypes: true }).slice(0, 200)) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name.startsWith("_")) continue;
      const dir = join(root, e.name);
      if (readProjectId(dir) === id) return dir;
    }
  } catch {}
  return "";
}

// ── Per-project hub routing (TDD §12.1) ──────────────────────────────────────
// A project lives on exactly ONE hub: RELAY_URL env → config hubs[project] → legacy global `url`
// → local default. Never throws: hooks run inside the user's tool loop and must fail open.
export const DEFAULT_HUB_URL = "http://127.0.0.1:4477";

// The bus directory, resolved in ONE place. Both override names (AGENT_BUS_DIR, RELAY_DATA_DIR) are
// honoured: a reader that honours neither mutates the user's REAL state during a drill. The env
// parameter form lets resolvers that take an env (resolveProject) stay hermetic under tests.
export function busDirFor(env = process.env) {
  return env.AGENT_BUS_DIR || env.RELAY_DATA_DIR || join(homedir(), ".agent-bus");
}
export function busDir() { return busDirFor(); }
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

// The real project(s) inside a folder of projects (#6842): the child repos carrying a CLAUDE.md.
// A stray clone or worktree beside the real one carries none. Same bounds as countChildRepos.
export function nestedProjects(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).slice(0, 200)
      .filter(e => e.isDirectory() && !e.name.startsWith(".")
        && existsSync(join(dir, e.name, ".git")) && existsSync(join(dir, e.name, "CLAUDE.md")))
      .map(e => join(dir, e.name)).sort();
  } catch { return []; }
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

// trantor — canonical project identity (client side).
// One repo = one lane. The loose `basename(cwd)` used everywhere before let a
// project fragment into multiple lanes (e.g. the host registered "builtbetter.ai"
// while its crew registered "builtbetter"). We now key by the GIT REPO ROOT
// basename, which is stable across subdirectories and sessions. An explicit
// RELAY_PROJECT always wins (deliberate override / crew inheritance). The hub
// applies an alias map on top of this to fold any historical divergence.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join, dirname } from "node:path";
import { homedir, hostname } from "node:os";

export function gitRoot(dir) {
  try {
    return execSync(`git -C ${JSON.stringify(dir)} rev-parse --show-toplevel`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
  } catch { return ""; }
}

// Stable project key for a working directory. RELAY_PROJECT > git-root basename > cwd basename.
export function resolveProject(cwd = process.cwd()) {
  if (process.env.RELAY_PROJECT) return process.env.RELAY_PROJECT.slice(0, 80);
  const root = gitRoot(cwd);
  return basename(root || cwd).slice(0, 80);
}

// ── Per-project hub routing (TDD §12.1) ──────────────────────────────────────
// A project lives on exactly ONE hub, and codependent projects MUST share one — collision
// detection and lateral review only work over work on the same hub. So RELAY_URL is no longer
// one global value: ~/.agent-bus/config.json gains a `hubs` map { <project>: <hubUrl> }.
// Resolution order: RELAY_URL env (explicit override — tests, crew seat inheritance) →
// hubs[project] → the legacy global `url` (pre-§12.1 installs keep working unchanged) → the
// local default. Never throws: hooks run inside the user's tool loop and MUST fail open.
export const DEFAULT_HUB_URL = "http://127.0.0.1:4477";

// The bus directory, resolved in ONE place. Both override names are honoured because both are
// already in use across the hooks (AGENT_BUS_DIR in api/prompt-focus/file-claim, RELAY_DATA_DIR in
// handoff/resources/update-check); a reader that honours neither will happily mutate the user's
// REAL state during a test. That is not hypothetical: on 2026-08-23 a pre-flight drill pointed at
// a temp bus dir and still CLAIMED two live pending handoffs, because the handoff reader joined
// homedir() directly while the writer honoured RELAY_DATA_DIR.
export function busDir() {
  return process.env.AGENT_BUS_DIR || process.env.RELAY_DATA_DIR || join(homedir(), ".agent-bus");
}
export function handoffDir() { return join(busDir(), "handoffs"); }
function configPath() { return join(busDir(), "config.json"); }

export function readConfig() {
  try { const c = configPath(); if (existsSync(c)) { const j = JSON.parse(readFileSync(c, "utf8")); if (j && typeof j === "object") return j; } } catch {}
  return {};
}

// HOW a hub was chosen, not merely which one. The silent fallback is the most expensive failure
// this system has: an unpinned project resolves to the global default, nothing errors, the seat
// looks healthy, and its work records on a hub nobody reads (2026-08-19 and again 2026-08-23,
// after a reboot reopened every window in $HOME). Provenance is therefore part of the answer, so
// callers that can warn — sessionstart, doctor, relay_whoami — can say WHY.
//   via "env"     → RELAY_URL (explicit override: tests, crew seats)
//   via "pin"     → config hubs[project]  (the only DELIBERATE routing)
//   via "global"  → config url            (fallback — the project was never pinned)
//   via "default" → built-in local        (fallback — there is no config at all)
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

// Is this directory a real project seat, and if not, WHY not? Returns "" for a seat, otherwise a
// short human reason. A non-seat must never register: it mints a phantom "<username>" or
// "development" board, and because that name is unpinned it lands on the local hub while the crew
// lives on the remote one — the exact split that makes an agent report "Trantor is unreachable"
// while every hub is healthy. An explicit RELAY_SESSION/RELAY_PROJECT is the deliberate opt-in.
export function nonSeatReason(dir = process.cwd(), env = process.env) {
  try {
    if (env.RELAY_SESSION || env.RELAY_PROJECT) return "";
    const home = homedir();
    if (dir === home) return "the home directory";
    const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
    if (dir.startsWith(join(claudeDir, "plugins", "cache"))) return "the plugin cache";
    // A WORKSPACE CONTAINER (~/development): not a repo itself, but holding several. This is the
    // directory a reopened window most often lands in after the home directory, and it is the
    // worst case — it registers as project "development", which nothing pins, so the seat lands
    // on the fallback hub while its crew is on the pinned one. Both look healthy. A plain non-git
    // directory is NOT disqualified: plenty of real projects have no repo yet.
    if (!gitRoot(dir) && countChildRepos(dir) >= 2) return "a folder of projects, not a project";
  } catch {}
  return "";
}

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

// Stable machine identity. os.hostname() is network-dependent — the same Mac reports
// "MacBook-Pro-M1.local" on one network and "MacBookPro.hsd1.fl.comcast.net" on another, which
// forks one machine into two session identities on the bus. Resolve a stable id ONCE and persist it
// to ~/.agent-bus/machine-id so it never drifts: RELAY_HOST_ID > persisted id > macOS LocalHostName
// (stable, no domain) > hostname() without its domain suffix.
let _hostId = null;
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

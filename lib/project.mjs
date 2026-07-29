// trantor — canonical project identity (client side).
// One repo = one lane. The loose `basename(cwd)` used everywhere before let a
// project fragment into multiple lanes (e.g. the host registered "builtbetter.ai"
// while its crew registered "builtbetter"). We now key by the GIT REPO ROOT
// basename, which is stable across subdirectories and sessions. An explicit
// RELAY_PROJECT always wins (deliberate override / crew inheritance). The hub
// applies an alias map on top of this to fold any historical divergence.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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

function busDir() { return process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus"); }
function configPath() { return join(busDir(), "config.json"); }

export function readConfig() {
  try { const c = configPath(); if (existsSync(c)) { const j = JSON.parse(readFileSync(c, "utf8")); if (j && typeof j === "object") return j; } } catch {}
  return {};
}

export function resolveHub(project, env = process.env) {
  try {
    if (env.RELAY_URL) return env.RELAY_URL;
    const cfg = readConfig();
    const name = project || resolveProject();
    const u = cfg?.hubs?.[name];
    if (u && typeof u === "string") return u;
    if (cfg?.url && typeof cfg.url === "string") return cfg.url;
  } catch {}
  return DEFAULT_HUB_URL;
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

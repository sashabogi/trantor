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

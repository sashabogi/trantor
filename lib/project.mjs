// trantor — canonical project identity (client side).
// One repo = one lane. The loose `basename(cwd)` used everywhere before let a
// project fragment into multiple lanes (e.g. the host registered "builtbetter.ai"
// while its crew registered "builtbetter"). We now key by the GIT REPO ROOT
// basename, which is stable across subdirectories and sessions. An explicit
// RELAY_PROJECT always wins (deliberate override / crew inheritance). The hub
// applies an alias map on top of this to fold any historical divergence.
import { execSync } from "node:child_process";
import { basename } from "node:path";

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

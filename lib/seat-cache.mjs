import { homedir } from "node:os";
import { join } from "node:path";

export function sharedCacheDir(project, home = homedir()) {
  const safeProject = String(project).replace(/\.{2,}/g, "_").replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(home, ".agent-bus", "cache", safeProject);
}

export function seatBuildCacheEnv(env, project, home = homedir()) {
  const cache = sharedCacheDir(project, home);
  return {
    ...env,
    CARGO_TARGET_DIR: env.CARGO_TARGET_DIR || join(cache, "cargo-target"),
    TRANTOR_SHARED_CACHE: cache,
  };
}

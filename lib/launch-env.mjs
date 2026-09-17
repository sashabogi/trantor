// trantor — the identity a terminal session exports (its project badge, its seat, its pane, its
// hub pin) must not reach a process that is not that session. The app relaunched from a badged crew
// pane carried the badge into every child it spawned, and `trantor open` followed it (#7414).
// Mirrors desktop/src-tauri/src/identity_env.rs: change both or neither.
export const IDENTITY_KEYS = [
  "TRANTOR_ORCH", "TRANTOR_SEAT",
  "HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID",
  "CLAUDECODE", "CLAUDE_PID", "CLAUDE_SESSION_ID", "CLAUDE_PROJECT_DIR",
];
export const IDENTITY_PREFIXES = ["RELAY_", "CLAUDE_CODE_"];

export function isIdentityKey(key) {
  return IDENTITY_KEYS.includes(key) || IDENTITY_PREFIXES.some(prefix => key.startsWith(prefix));
}

// The env for a process that must be nobody in particular: the host env minus every identity name.
export function cleanLaunchEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isIdentityKey(key)) out[key] = value;
  }
  return out;
}

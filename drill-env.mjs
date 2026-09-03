// Shared drill env (#6108): a gate runner or crew seat lives in a herdr pane and exports exactly
// the identity vars the resolvers read FIRST (HERDR_PANE_ID, TRANTOR_ORCH, RELAY_PROJECT, ...).
// Any drill spawn that passes process.env through inherits the RUNNER's identity, so results
// depend on who runs the suite. Every spawn that exercises identity-sensitive code builds its env
// with drillEnv(): the mechanical vars (PATH/HOME/TMPDIR) are inherited, the identity vars are
// deleted, and per-case overrides win — set or deleted ON PURPOSE, never by accident of who ran
// the drill (pattern proven in test-baton-surface.mjs, #6074 bounce).
export const DRILL_IDENTITY_VARS = [
  "HERDR_ENV", "HERDR_PANE_ID", "TRANTOR_ORCH",
  "RELAY_PROJECT", "TRANTOR_PROJECT", "RELAY_SESSION", "RELAY_AGENT",
];

// Child env for a drill spawn: host env minus identity, plus the caller's deliberate overrides.
export function drillEnv(overrides = {}) {
  const env = { ...process.env };
  for (const k of DRILL_IDENTITY_VARS) delete env[k];
  return Object.assign(env, overrides);
}

// Pin the DRILL'S OWN process before in-process lib calls (unit assertions that would otherwise
// read the runner's RELAY_PROJECT out of process.env).
export function scrubIdentityEnv() {
  for (const k of DRILL_IDENTITY_VARS) delete process.env[k];
}

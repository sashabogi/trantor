// Shared drill env (#6108): a gate runner or crew seat lives in a herdr pane and exports exactly
// the identity vars the resolvers read FIRST. Any drill spawn that passes process.env through
// inherits the RUNNER's identity, so results depend on who ran the suite — drillEnv() deletes the
// identity vars and applies only the caller's deliberate overrides (pattern from #6074).
export const DRILL_IDENTITY_VARS = [
  "HERDR_ENV", "HERDR_PANE_ID", "TRANTOR_ORCH", "TRANTOR_SEAT",
  "RELAY_PROJECT", "TRANTOR_PROJECT", "RELAY_SESSION", "RELAY_AGENT",
  // The hub binding is identity too (#7893): a spawn inheriting the RUNNER's RELAY_URL resolves
  // "via env" and can never exercise pin/path resolution.
  "RELAY_URL",
  // A mode flag scrubbed for the same reason: a seat under Trantor State exports it and drills
  // inheriting it armed state mode in every spawned runner (#7759).
  "TRANTOR_STATE_ASSEMBLE",
  // The secret store backend is the operator's choice, never a drill's inheritance (#6393).
  "TRANTOR_SECRETS_BACKEND", "TRANTOR_SECRETS_KEYCHAIN",
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

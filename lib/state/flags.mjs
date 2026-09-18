// Trantor State flags (#7159) — the ONE place the runner's TRANTOR_STATE* names resolve. The runner
// boots from its OWN process env, so a flag set in ~/.agent-bus/.env (the file the turn wrapper
// sources on the spawned CLI, one level too deep for the runner) never reached it. Here process env
// wins and the file fills every name the launcher did not set; `trantor doctor` reports the layers.
import { join } from "node:path";
import { homedir } from "node:os";
import { parseEnvFile } from "../provider-keys.mjs";

/** §4.6: absent or not "1" = the transcript path, byte for byte. The name lives here so the list
 *  below and the runner's armed check cannot drift; driver.mjs re-exports it for its importers. */
export const STATE_ENV = "TRANTOR_STATE_ASSEMBLE";

// The names bin/crew/core.mjs forwards from whoever ran `trantor up` — one list, so forwarding and
// resolution cannot drift apart.
export const STATE_FLAGS = ["TRANTOR_STATE", "TRANTOR_STATE_ASSEMBLE", "TRANTOR_STATE_HANDOFF", "TRANTOR_STATE_GATE"];

/** `{ [name]: { value, layer } }` per flag; layer is "process env", "~/.agent-bus/.env (crew)" or
 *  "unset". Pure — env in, no writes — so the doctor reports the same answer the runner got. */
export function resolveStateFlags(env = process.env, file = join(homedir(), ".agent-bus", ".env")) {
  const fromFile = parseEnvFile(file);   // a missing file parses to {}
  return Object.fromEntries(STATE_FLAGS.map((name) => {
    if (env[name] !== undefined) return [name, { value: env[name], layer: "process env" }];
    if (fromFile[name] !== undefined) return [name, { value: fromFile[name], layer: "~/.agent-bus/.env (crew)" }];
    return [name, { value: "", layer: "unset" }];
  }));
}

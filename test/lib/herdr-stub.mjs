import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { call, commandExists } from "../../bin/crew/core.mjs";

// #13922: a crew test running against the LIVE herdr socket can close the workspace it lives in
// (11-20: one workspace.close from a seat's test run took every netcup seat pane down). herdr
// resolves HERDR_SOCKET_PATH → $HOME/.config/herdr/herdr.sock and bin/crew/herdr.mjs spawns
// `herdr` from PATH with ctx.env — so PATH, HOME and HERDR_SOCKET_PATH are the seams a test owns.

/** The socket the herdr CLI would connect to under `env` — the CLI's own resolution order. */
export function herdrSocketFor(env = process.env) {
  const explicit = String(env.HERDR_SOCKET_PATH || "").trim();
  if (explicit) return explicit;
  return join(String(env.HOME || ""), ".config", "herdr", "herdr.sock");
}

/** The box's REAL herdr socket: what `herdr status` reports under the caller's env, with the
 * runner-stamped path (test/run.mjs captures it before scrubbing identity) and env/home fallbacks.
 * `herdr status` is read-only; nothing here mutates the live server. */
export function realHerdrSocket(env = process.env) {
  const stamped = String(env.TRANTOR_TEST_HERDR_REAL_SOCK || "").trim();
  if (stamped) return stamped;
  const explicit = String(env.HERDR_SOCKET_PATH || "").trim();
  if (explicit) return explicit;
  if (commandExists("herdr", env)) {
    const line = call("herdr", ["status"], { env }).stdout.split("\n").find(l => l.trim().startsWith("socket:"));
    if (line) return line.replace(/^.*socket:\s*/, "").trim();
  }
  return herdrSocketFor(env);
}

function sameSocket(a, b) {
  if (!a || !b || a === b) return Boolean(a && b && a === b);
  // A stub env can SYMLINK the real socket into its temp home (bin/drill-seams.mjs does exactly
  // that) — resolve both ends when they exist so the alias trips the gate too.
  try {
    return existsSync(a) && existsSync(b) && realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** Fail closed: if `env` resolves herdr to the real socket, abort before any herdr call. */
export function assertHerdrIsolated(env, label = "test") {
  const socket = herdrSocketFor(env);
  const real = realHerdrSocket();
  if (sameSocket(socket, real)) {
    throw new Error(`herdr isolation FAILED CLOSED (${label}): the env resolves herdr to the REAL socket ${real} — aborting before any herdr call. Point HOME/HERDR_SOCKET_PATH at a stub under the test's temp dir.`);
  }
  return socket;
}

/** Write the stub herdr binary into `dir` (put `dir` FIRST on the test's PATH). It logs every call
 * to $HERDR_STUB_LOG and answers the crew surface with JSON the parser accepts; it owns no socket,
 * so nothing it answers can reach a live server. Live workspace/pane lists replay the caller's
 * HERDR_LIVE_WS / HERDR_LIVE_PANES fixtures. Returns the binary's path. */
export function writeStubHerdr(dir) {
  mkdirSync(dir, { recursive: true });
  const stub = join(dir, "herdr");
  writeFileSync(stub, `#!/bin/bash
# test stub herdr (#13922): answers the crew surface, never a socket
[ -n "\${HERDR_STUB_LOG:-}" ] && echo "herdr \$*" >> "\$HERDR_STUB_LOG"
case "\$1 \$2" in
  "workspace create"*) printf '{"result":{"workspace":{"workspace_id":"WS-1"},"root_pane":{"pane_id":"P-1"}}}\\n' ;;
  "workspace list"*) printf '{"result":{"workspaces":[%s]}}\\n' "\${HERDR_LIVE_WS:-}" ;;
  "pane split"*) printf '{"result":{"pane":{"pane_id":"P-SPLIT"}}\\n' ;;
  "pane list"*) printf '{"result":{"panes":[%s]}}\\n' "\${HERDR_LIVE_PANES:-}" ;;
  "pane process-info"*) printf '{"result":{"process_info":{"foreground_processes":[{"name":"zsh","pid":456}]}}}' ;;
  "agent list"*) printf '{"result":{"agents":[]}}' ;;
esac
exit 0
`);
  chmodSync(stub, 0o755);
  return stub;
}

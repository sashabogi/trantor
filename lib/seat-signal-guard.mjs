import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

// Install after env files are sourced so a provider's PATH cannot hide the guard.
export function seatSignalPrefix(workdir, env = process.env, root = process.pid) {
  const parent = join(workdir, ".agent-bus-out", "signal-guard");
  const dir = join(parent, String(root));
  mkdirSync(dir, { recursive: true });
  // Runtime shims must not count as seat work or enter a cut snapshot in arbitrary repositories.
  writeFileSync(join(parent, ".gitignore"), "*\n");
  const guard = fileURLToPath(new URL("../bin/seat-signal.mjs", import.meta.url));
  for (const name of ["kill", "pkill", "killall"]) {
    writeFileSync(join(dir, name), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(guard)} ${name} "$@"\n`, { mode: 0o755 });
  }
  const path = `export PATH=${quote(dir)}:"$PATH"\n`;
  const bash = join(dir, "bash-env");
  const previousBash = env.BASH_ENV && env.BASH_ENV !== bash
    ? `[ ! -f ${quote(env.BASH_ENV)} ] || . ${quote(env.BASH_ENV)}\n` : "";
  writeFileSync(bash, `${previousBash}${path}enable -n kill\n`);
  const previousZdot = env.ZDOTDIR || env.HOME;
  for (const name of [".zshenv", ".zprofile", ".zshrc", ".zlogin"]) {
    const original = previousZdot && previousZdot !== dir ? join(previousZdot, name) : "";
    const source = original ? `[ ! -f ${quote(original)} ] || . ${quote(original)}\n` : "";
    writeFileSync(join(dir, name), `${source}${path}disable kill\n`);
  }
  return `export TRANTOR_SIGNAL_ROOT=${quote(root)} BASH_ENV=${quote(bash)} ZDOTDIR=${quote(dir)}\n${path}enable -n kill\n`;
}

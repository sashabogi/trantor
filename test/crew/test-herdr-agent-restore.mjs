import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { plistBody, restoreScriptBody, restoreWired } from "../../bin/herdr-agent.mjs";

const herdr = "/opt/herdr";
const script = restoreScriptBody({ herdr, node: "/usr/bin/node", cli: "/opt/trantor/bin/cli.mjs", log: "/tmp/trantor-herdr-restore.log" });
const plist = plistBody(herdr, "/Users/example/Library/LaunchAgents/trantor-herdr-restore.sh");
assert.ok(plist.indexOf("trantor-herdr-restore.sh") < plist.indexOf("status: running"), "plist starts restore watcher before server status check");
assert.ok(script.includes("TRANTOR_RESTORE_WAIT_SECONDS:-60"));
assert.ok(script.includes("trantor-herdr-restore-$BOOT_KEY.done"));
assert.ok(script.includes("\"$NODE_BIN\" \"$TRANTOR_CLI\" restore >> \"$RESTORE_LOG\" 2>&1"));
assert.equal(restoreWired(plist, script), true);
assert.equal(restoreWired(plist, ""), false);

const root = mkdtempSync(join(tmpdir(), "herdr-login-restore-"));
try {
  const fakeHerdr = join(root, "herdr");
  const fakeCli = join(root, "cli.mjs");
  const restoreLog = join(root, "restore.log");
  const markerDir = join(root, "markers");
  mkdirSync(markerDir);
  writeFileSync(fakeHerdr, "#!/bin/sh\nif [ \"$HERDR_FAKE_RUNNING\" = 1 ]; then echo 'status: running'; exit 0; fi\necho 'status: stopped'; exit 1\n");
  chmodSync(fakeHerdr, 0o755);
  writeFileSync(fakeCli, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(join(root, "restore-calls.log"))}, 'called\\n');\n`);
  const generated = join(root, "restore.sh");
  writeFileSync(generated, restoreScriptBody({ herdr: fakeHerdr, node: process.execPath, cli: fakeCli, log: restoreLog }));
  chmodSync(generated, 0o755);
  const env = { ...process.env, TRANTOR_RESTORE_MARKER_DIR: markerDir, TRANTOR_RESTORE_BOOT_KEY: "123", TRANTOR_RESTORE_WAIT_SECONDS: "2", TRANTOR_RESTORE_SLEEP_SECONDS: "0", TRANTOR_RESTORE_LOG: restoreLog };
  const first = spawnSync("/bin/bash", [generated], { encoding: "utf8", env: { ...env, HERDR_FAKE_RUNNING: "1" } });
  assert.equal(first.status, 0, first.stderr);
  const second = spawnSync("/bin/bash", [generated], { encoding: "utf8", env: { ...env, HERDR_FAKE_RUNNING: "1" } });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(join(root, "restore-calls.log"), "utf8"), "called\n", "boot marker suppresses KeepAlive duplicate");

  const downLog = join(root, "down.log");
  const down = spawnSync("/bin/bash", [generated], { encoding: "utf8", env: { ...env, TRANTOR_RESTORE_BOOT_KEY: "456", TRANTOR_RESTORE_LOG: downLog, HERDR_FAKE_RUNNING: "0" } });
  assert.equal(down.status, 0, down.stderr);
  assert.equal(readFileSync(join(root, "restore-calls.log"), "utf8"), "called\n", "herdr down never invokes restore");
  assert.match(readFileSync(downLog, "utf8"), /restore skipped/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

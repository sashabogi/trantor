#!/usr/bin/env node
// Keep herdr alive across reboot; Trantor restores opted-in orchestrators after its server returns.
// Server lifetime and conversation restore are separate: `trantor open` resumes the project session.
import { existsSync, writeFileSync, unlinkSync, mkdirSync, chmodSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "com.trantor.herdr";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG = "/tmp/trantor-herdr-server.log";
const RESTORE_LOG = "/tmp/trantor-herdr-restore.log";
const RESTORE_SCRIPT = join(homedir(), "Library", "LaunchAgents", "trantor-herdr-restore.sh");
const D = "\x1b[2m", R = "\x1b[0m";

const shellQuote = value => `'${String(value).replaceAll("'", `'\\''`)}'`;
const xmlEscape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function herdrBin() {
  // launchd runs with a minimal PATH, so the absolute path has to be baked in at install time.
  for (const p of [join(homedir(), ".local/bin/herdr"), "/opt/homebrew/bin/herdr", "/usr/local/bin/herdr"]) {
    if (existsSync(p)) return p;
  }
  try {
    const found = execFileSync("/usr/bin/which", ["herdr"], { encoding: "utf8" }).trim();
    if (found) return found;
  } catch { /* not on PATH either */ }
  return "";
}

export function restoreScriptBody({ herdr = "herdr", node = process.execPath, cli = join(dirname(fileURLToPath(import.meta.url)), "cli.mjs"), log = RESTORE_LOG } = {}) {
  return `#!/bin/bash
HERDR_BIN=\${TRANTOR_HERDR_BIN:-${shellQuote(herdr)}}
NODE_BIN=\${TRANTOR_NODE_BIN:-${shellQuote(node)}}
TRANTOR_CLI=\${TRANTOR_CLI_PATH:-${shellQuote(cli)}}
RESTORE_LOG=\${TRANTOR_RESTORE_LOG:-${shellQuote(log)}}
MARKER_DIR=\${TRANTOR_RESTORE_MARKER_DIR:-/tmp}
BOOT_KEY=\${TRANTOR_RESTORE_BOOT_KEY:-$(/usr/sbin/sysctl -n kern.boottime 2>/dev/null | sed -E 's/.*sec = ([0-9]+).*/\\1/')}
WAIT_SECONDS=\${TRANTOR_RESTORE_WAIT_SECONDS:-60}
SLEEP_SECONDS=\${TRANTOR_RESTORE_SLEEP_SECONDS:-1}

if [[ ! "$BOOT_KEY" =~ ^[0-9]+$ ]]; then
  echo "$(date -u '+%FT%TZ') herdr restore skipped: could not determine boot time" >> "$RESTORE_LOG"
  exit 0
fi
MARKER="$MARKER_DIR/trantor-herdr-restore-$BOOT_KEY.done"
if [ -d "$MARKER" ]; then exit 0; fi

elapsed=0
while [ "$elapsed" -lt "$WAIT_SECONDS" ]; do
  if "$HERDR_BIN" status 2>/dev/null | grep -q 'status: running'; then
    if mkdir "$MARKER" 2>/dev/null; then
      echo "$(date -u '+%FT%TZ') herdr is running; restoring opted-in Trantor orchestrators" >> "$RESTORE_LOG"
      "$NODE_BIN" "$TRANTOR_CLI" restore >> "$RESTORE_LOG" 2>&1
      result=$?
      echo "$(date -u '+%FT%TZ') trantor restore exited $result" >> "$RESTORE_LOG"
    fi
    exit 0
  fi
  sleep "$SLEEP_SECONDS"
  elapsed=$((elapsed + 1))
done
echo "$(date -u '+%FT%TZ') herdr did not answer status within $WAIT_SECONDS seconds; restore skipped" >> "$RESTORE_LOG"
exit 0
`;
}

export function plistBody(bin, restoreScript = RESTORE_SCRIPT) {
  const launch = xmlEscape(`/bin/bash ${shellQuote(restoreScript)} >/dev/null 2>&1 & ${shellQuote(bin)} status 2>/dev/null | grep -q 'status: running' && exit 0; exec ${shellQuote(bin)} server`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <!-- Idempotent on purpose. A second herdr server against a live one prints "already running"
         and exits 1, so a plain KeepAlive would respawn it every 10s forever. Bail out cleanly
         instead, and only exec when nothing is holding the socket. -->
    <string>${launch}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <!-- Restart a server that DIED, never one that stopped cleanly (herdr server stop) or one that
       bailed because another was already up. -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`;
}

export function restoreWired(plist, script) {
  return String(plist || "").includes("trantor-herdr-restore.sh")
    && String(script || "").includes("restore >> \"$RESTORE_LOG\"")
    && String(script || "").includes("trantor-herdr-restore-$BOOT_KEY.done");
}

function main() {
const cmd = process.argv[2] || "status";
const uid = process.getuid();

if (cmd === "install") {
  const bin = herdrBin();
  if (!bin) {
    console.error("herdr is not installed — get it first: curl -fsSL https://herdr.dev/install.sh | sh");
    process.exit(1);
  }
  mkdirSync(dirname(PLIST), { recursive: true });
  writeFileSync(RESTORE_SCRIPT, restoreScriptBody({ herdr: bin }));
  chmodSync(RESTORE_SCRIPT, 0o755);
  writeFileSync(PLIST, plistBody(bin));
  // bootout first so a re-install replaces rather than stacks
  try { execFileSync("/bin/launchctl", ["bootout", `gui/${uid}/${LABEL}`], { stdio: "ignore" }); } catch { /* not loaded */ }
  try {
    execFileSync("/bin/launchctl", ["bootstrap", `gui/${uid}`, PLIST], { stdio: "ignore" });
  } catch (e) {
    console.error(`wrote ${PLIST} but launchctl bootstrap failed: ${e?.message || e}`);
    process.exit(1);
  }
  console.log(`herdr's server now starts at login (${bin} server)`);
  console.log(`${D}plist: ${PLIST}   log: ${LOG}   restore log: ${RESTORE_LOG}${R}`);
} else if (cmd === "remove") {
  try { execFileSync("/bin/launchctl", ["bootout", `gui/${uid}/${LABEL}`], { stdio: "ignore" }); } catch { /* not loaded */ }
  if (existsSync(PLIST)) { unlinkSync(PLIST); console.log("removed the herdr login agent"); }
  else console.log("no herdr login agent installed");
} else if (cmd === "status") {
  const installed = existsSync(PLIST);
  let loaded = false;
  try {
    loaded = execFileSync("/bin/launchctl", ["list"], { encoding: "utf8" }).split("\n").some(l => l.includes(LABEL));
  } catch { /* launchctl unavailable */ }
  let running = false;
  try { running = /status:\s*running/.test(execFileSync(herdrBin() || "herdr", ["status"], { encoding: "utf8" })); } catch { /* server down */ }
  let wired = false;
  try { wired = restoreWired(readFileSync(PLIST, "utf8"), readFileSync(RESTORE_SCRIPT, "utf8")); } catch { /* missing helper */ }
  console.log(`login agent: ${installed ? "installed" : "not installed"}${installed ? ` (${loaded ? "loaded" : "NOT loaded"})` : ""}`);
  console.log(`herdr server: ${running ? "running" : "not running"}`);
  console.log(`Trantor restore: ${wired ? "wired after herdr starts" : "not wired"}`);
  if (!installed) console.log(`${D}install it so panes survive a reboot: trantor herdr install${R}`);
} else {
  console.log("usage: trantor herdr install | remove | status");
  process.exit(1);
}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

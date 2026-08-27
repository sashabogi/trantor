#!/usr/bin/env node
// Keep herdr's server alive across a reboot.
//
// herdr already holds every pane in a background server, so quitting the app or closing a Terminal
// window never costs you a session. A REBOOT does: the server dies with everything else, and
// nothing brings it back, so the next `trantor open` finds no workspace and starts over. That was
// the missing half of "it survives restarts" (card #5401).
//
// This is only the SERVER's lifetime. The conversation inside a pane is a separate problem, solved
// in crew.sh: the project keeps one claude session id and `open` resumes it.
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const LABEL = "com.trantor.herdr";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG = "/tmp/trantor-herdr-server.log";
const D = "\x1b[2m", R = "\x1b[0m";

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

const plistBody = (bin) => `<?xml version="1.0" encoding="UTF-8"?>
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
    <string>${bin} status 2>/dev/null | grep -q 'status: running' &amp;&amp; exit 0; exec ${bin} server</string>
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

const cmd = process.argv[2] || "status";
const uid = process.getuid();

if (cmd === "install") {
  const bin = herdrBin();
  if (!bin) {
    console.error("herdr is not installed — get it first: curl -fsSL https://herdr.dev/install.sh | sh");
    process.exit(1);
  }
  mkdirSync(dirname(PLIST), { recursive: true });
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
  console.log(`${D}plist: ${PLIST}   log: ${LOG}${R}`);
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
  console.log(`login agent: ${installed ? "installed" : "not installed"}${installed ? ` (${loaded ? "loaded" : "NOT loaded"})` : ""}`);
  console.log(`herdr server: ${running ? "running" : "not running"}`);
  if (!installed) console.log(`${D}install it so panes survive a reboot: trantor herdr install${R}`);
} else {
  console.log("usage: trantor herdr install | remove | status");
  process.exit(1);
}

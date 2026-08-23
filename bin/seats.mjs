#!/usr/bin/env node
// trantor seats — declare which project lives in which directory, see which ones are missing, and
// put them back. The answer to "a reboot reopened every window in $HOME and un-seated the crew".
//
//   trantor seats                     status of every declared seat
//   trantor seats add <project> [dir] declare one (dir defaults to the cwd)
//   trantor seats remove <project>    undeclare one
//   trantor seats adopt [workspace]   declare every pinned project found under a workspace root
//   trantor seats up [project…]       open a window for each MISSING seat, in its own directory
//   trantor seats login install       bring missing seats back automatically after a reboot
//   trantor seats login uninstall|status
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  readSeats, declareSeat, undeclareSeat, seatStatus, missingSeats,
  launchSeat, suggestSeats, projectForDir,
} from "../lib/seats.mjs";

const args = process.argv.slice(2);
const sub = args[0] || "status";
const flag = (n) => args.includes(`--${n}`);
const rest = args.slice(1).filter(a => !a.startsWith("--"));

const G = "\x1b[32m", O = "\x1b[1;38;5;208m", D = "\x1b[2m", R = "\x1b[0m";
const LABEL = "com.trantor.seats";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

function printStatus() {
  const rows = seatStatus();
  if (!rows.length) {
    console.log("No seats declared yet.");
    console.log(`Declare the one you are standing in:  ${O}trantor seats add ${projectForDir(process.cwd())}${R}`);
    console.log(`…or adopt every pinned project under a workspace:  ${O}trantor seats adopt ~/development${R}`);
    return 0;
  }
  const w = Math.max(...rows.map(r => r.project.length), 7);
  console.log(`${D}seat${" ".repeat(Math.max(0, w - 4))}  status              directory${R}`);
  for (const r of rows) {
    const status = r.live ? `${G}live${R} ${D}(${r.agent} ${r.pid})${R}`
      : r.exists ? `${O}MISSING${R}` : `${O}NO DIR${R}`;
    const pad = " ".repeat(Math.max(0, w - r.project.length));
    console.log(`${r.project}${pad}  ${status}${" ".repeat(Math.max(1, 20 - (r.live ? 4 + String(r.pid).length + r.agent.length + 4 : 7)))}${D}${r.dir}${R}`);
    if (r.via !== "pin") console.log(`${" ".repeat(w + 2)}${O}⚠ hub not pinned${R} ${D}— resolves to ${r.hub} via ${r.via}; pin it: trantor hub set ${r.project} <url>${R}`);
  }
  const miss = rows.filter(r => !r.live && r.exists);
  console.log("");
  if (miss.length) {
    console.log(`${O}${miss.length} seat(s) not running${R}: ${miss.map(m => m.project).join(", ")}`);
    console.log(`Bring them back:  ${O}trantor seats up${R}`);
  } else {
    console.log(`${G}every declared seat is live${R}`);
  }
  return miss.length ? 1 : 0;
}

function trantorBin() {
  try { return execFileSync("/usr/bin/which", ["trantor"], { encoding: "utf8" }).trim() || "trantor"; }
  catch { return "trantor"; }
}

// One-shot login job. Deliberately NOT KeepAlive: a KeepAlive job whose command fails relaunches
// every ThrottleInterval forever, which is precisely how this machine ended up at load 490 on
// 2026-08-21 (four portless services rebuilding every 10s). It runs once, after a delay that lets
// the desktop settle, and exits.
function plistBody(delay) {
  const bin = trantorBin();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>sleep ${delay}; exec ${bin} seats up --login</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/trantor-seats-login.log</string>
  <key>StandardErrorPath</key><string>/tmp/trantor-seats-login.log</string>
</dict>
</plist>
`;
}

switch (sub) {
  case "status": case "list": case "ls":
    process.exit(printStatus());
    break;

  case "add": {
    const project = rest[0] || projectForDir(process.cwd());
    const dir = resolve(rest[1] || process.cwd());
    try {
      const s = declareSeat(project, dir);
      console.log(`${G}declared${R} ${s.project} → ${s.dir}`);
      const natural = projectForDir(dir);
      if (natural !== project) {
        console.log(`${O}⚠ that directory registers as "${natural}", not "${project}"${R}`);
        console.log(`  A session started there will come up as "${natural}" — so this seat would never match.`);
        console.log(`  Either declare it as "${natural}", or set RELAY_PROJECT=${project} when starting it.`);
      }
    } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
    break;
  }

  case "remove": case "rm": {
    const project = rest[0];
    if (!project) { console.error("usage: trantor seats remove <project>"); process.exit(1); }
    console.log(undeclareSeat(project) ? `removed ${project}` : `${project} was not declared`);
    break;
  }

  case "adopt": {
    const workspace = resolve(rest[0] || join(homedir(), "development"));
    const found = suggestSeats(workspace);
    if (!found.length) { console.log(`nothing to adopt under ${workspace} (every pinned project is already declared, or has no directory there)`); break; }
    console.log(`Found ${found.length} pinned project(s) with a directory under ${workspace}:`);
    for (const f of found) console.log(`  ${f.project} → ${f.dir}`);
    if (!flag("yes")) { console.log(`\nRe-run with ${O}--yes${R} to declare them.`); break; }
    for (const f of found) { try { declareSeat(f.project, f.dir); console.log(`${G}declared${R} ${f.project}`); } catch (e) { console.error(`  skip ${f.project}: ${e.message}`); } }
    break;
  }

  case "up": {
    const only = rest;
    let miss = missingSeats();
    if (only.length) miss = miss.filter(m => only.includes(m.project));
    const login = flag("login");
    if (!miss.length) {
      if (!login) console.log(`${G}nothing to do — every declared seat is live${R}`);
      else console.log(`[${new Date().toISOString()}] all declared seats live; nothing launched`);
      break;
    }
    // A guard rail, not a policy: launching a dozen agent windows at once is never what anyone
    // meant, and at login it would be actively hostile.
    const CAP = 6;
    if (miss.length > CAP && !flag("force")) {
      console.error(`${O}${miss.length} seats are missing — refusing to open that many windows at once.${R}`);
      console.error(`Name the ones you want (trantor seats up <project>…), or pass --force.`);
      process.exit(1);
    }
    for (const m of miss) {
      const r = launchSeat(m, { dryRun: flag("dry-run") });
      const when = login ? `[${new Date().toISOString()}] ` : "";
      if (r.launched) console.log(`${when}${G}opened${R} ${m.project} — ${m.dir}`);
      else if (flag("dry-run")) console.log(`${when}would run: ${r.command}`);
      else console.log(`${when}${O}could not open a window${R} for ${m.project}; run it yourself: ${r.command}${r.error ? ` (${r.error})` : ""}`);
    }
    break;
  }

  case "login": {
    const action = rest[0] || "status";
    if (action === "install") {
      if (process.platform !== "darwin") { console.error("the login agent is macOS-only"); process.exit(1); }
      const delay = Number(rest[1] || 60);
      writeFileSync(PLIST, plistBody(Number.isFinite(delay) && delay >= 0 ? delay : 60));
      try { execFileSync("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`], { stdio: "ignore" }); } catch {}
      try {
        execFileSync("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, PLIST], { stdio: "ignore" });
        console.log(`${G}installed${R} — after a reboot, missing seats reopen in their own directories (${delay}s after login).`);
        console.log(`${D}plist: ${PLIST}   log: /tmp/trantor-seats-login.log${R}`);
        console.log(`${D}one-shot job, no KeepAlive — it runs once per login and exits.${R}`);
      } catch (e) { console.error(`wrote ${PLIST} but launchctl bootstrap failed: ${e?.message || e}`); process.exit(1); }
    } else if (action === "uninstall") {
      try { execFileSync("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`], { stdio: "ignore" }); } catch {}
      if (existsSync(PLIST)) { unlinkSync(PLIST); console.log("removed the login agent"); }
      else console.log("no login agent installed");
    } else {
      const installed = existsSync(PLIST);
      console.log(installed ? `login agent INSTALLED (${PLIST})` : "login agent not installed");
      if (installed) {
        try { console.log(execFileSync("/bin/launchctl", ["list"], { encoding: "utf8" }).split("\n").filter(l => l.includes(LABEL)).join("\n") || "(loaded state unknown)"); } catch {}
      } else {
        console.log(`Install it with:  ${O}trantor seats login install${R}`);
      }
    }
    break;
  }

  default:
    console.log(`usage: trantor seats [status|add|remove|adopt|up|login]

  status                    which declared seats are live, which are missing (default)
  add <project> [dir]       declare a seat (dir defaults to the current directory)
  remove <project>          undeclare a seat
  adopt [workspace] --yes   declare every pinned project that has a directory there
  up [project…]             open a window for each missing seat, in its own directory
                            (--dry-run to see the commands, --force past the 6-seat cap)
  login install [delay]     reopen missing seats automatically after a reboot
  login uninstall|status

Seats live in ~/.agent-bus/config.json alongside the hub pins. A seat is "live" when a real agent
process is standing in its directory — not when something on the hub claims that name.`);
    process.exit(readSeats() ? 0 : 0);
}

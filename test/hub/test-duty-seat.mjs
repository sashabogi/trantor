#!/usr/bin/env node
// Duty must pin its own model instead of inheriting an expensive interactive default.
// A fake Claude records argv from the real runner without starting an operator session.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "../drill-env.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log("# trantor duty-seat drill");

// a hub that answers everything duty/crew-runner needs, and never 401s
const hub = http.createServer((req, res) => {
  let b = ""; req.on("data", c => (b += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    res.writeHead(200, { "content-type": "application/json" });
    if (u.pathname === "/poll") return setTimeout(() => res.end(JSON.stringify({ messages: [], cursor: 0 })), 200);
    res.end(JSON.stringify({ ok: true, peers: [], messages: [], cursor: 0, lessons: [], token: "t", id: 1 }));
  });
});
await new Promise(r => hub.listen(0, "127.0.0.1", r));
const HUB = `http://127.0.0.1:${hub.address().port}`;

// Runs `duty.mjs up` in a throwaway bus dir (never the real ~/.agent-bus, whose seat we must not
// touch) and returns what the run produced.
async function dutyUp(extraArgs = [], extraEnv = {}) {
  const w = mkdtempSync(join(tmpdir(), "tt-dutymodel-"));
  const BUS = join(w, "bus"); mkdirSync(join(BUS, "fleet"), { recursive: true });
  const fakebin = join(w, "bin"); mkdirSync(fakebin, { recursive: true });
  // Each leg is fresh; production's prior-seat sweep must not reach host processes.
  writeFileSync(join(fakebin, "pkill"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const ARGV = join(w, "argv.log");
  writeFileSync(join(fakebin, "claude"), `#!/bin/sh\necho "$@" >> ${ARGV}\nexit 0\n`);
  chmodSync(join(fakebin, "claude"), 0o755);
  const OSA = join(w, "osascript.log");
  writeFileSync(join(fakebin, "osascript"), `#!/bin/sh\necho "$@" >> ${OSA}\ncat >> ${OSA} 2>/dev/null </dev/stdin\nexit 0\n`);
  chmodSync(join(fakebin, "osascript"), 0o755);
  // launchctl, stubbed the way launchd BEHAVES: a bootstrap actually runs the plist's launcher
  // (detached), with stdout where the plist points. A no-op stub would make the keepalive drills
  // pass vacuously — `up` would report "no runner seen" and the seat would never run a turn.
  const LC = join(w, "launchctl.log");
  const spawnedPids = join(w, "spawned-pids");
  writeFileSync(join(fakebin, "launchctl"), `#!/bin/sh
echo "$@" >> ${LC}
case "$1" in
  bootstrap)
    PL="$3"
    L=$(sed -n 's/.*<string>\\(.*duty-launch\\.sh\\)<\\/string>.*/\\1/p' "$PL" | head -1)
    O=$(sed -n 's/.*<string>\\(.*duty\\.log\\)<\\/string>.*/\\1/p' "$PL" | head -1)
    if [ -n "$L" ]; then
      nohup /bin/bash "$L" >> "\${O:-/dev/null}" 2>&1 &
      echo $! >> "${spawnedPids}"
    fi
    ;;
esac
exit 0
`);
  chmodSync(join(fakebin, "launchctl"), 0o755);
  writeFileSync(join(BUS, "config.json"), JSON.stringify({ url: HUB, ownerIdentity: "admin" }));

  // Model overrides must come from extraEnv, not the seat running this drill.
  const baseEnv = { ...drillEnv() };
  for (const k of ["CREW_MODEL", "CREW_KICKOFF", "RUNNER_RULES", "RUNNER_TITLE", "RUNNER_ABOUT"]) delete baseEnv[k];

  // async spawn, never spawnSync: the mock hub lives in THIS process, so a synchronous child would
  // block the event loop that has to answer its requests, and duty would time out on its own probe.
  const r = await new Promise((resolve) => {
    const kid = spawn(process.execPath, [join(ROOT, "bin", "duty.mjs"), "up", "--hub", HUB, ...extraArgs], {
      stdio: ["ignore", "pipe", "pipe"],
      // Pin Terminal so the stubbed osascript observes the window payload even with cmux installed.
      env: { ...baseEnv, HOME: w, AGENT_BUS_DIR: BUS, PATH: `${fakebin}:${process.env.PATH}`,
             RELAY_URL: HUB, TRANTOR_NO_UPDATE_CHECK: "1", CREW_MUX: "terminal", ...extraEnv },
    });
    let so = "", se = "";
    kid.stdout.on("data", d => (so += d)); kid.stderr.on("data", d => (se += d));
    kid.on("close", () => resolve({ stdout: so, stderr: se }));
    setTimeout(() => { try { kid.kill("SIGKILL"); } catch {} }, 25000).unref?.();
  });
  await sleep(4500);                                  // let the kickoff turn actually run
  // Window mode records PID 0 because osascript is stubbed; never signal the caller's group.
  try { const pid = Number(readFileSync(join(BUS, "duty.pid"), "utf8")); if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGKILL"); } catch {}
  // The fake launchctl owns these launcher PIDs; cleanup must never match process names.
  if (existsSync(spawnedPids)) {
    for (const value of readFileSync(spawnedPids, "utf8").trim().split(/\s+/)) {
      const pid = Number(value);
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    }
  }
  const log = (() => { try { return readFileSync(join(BUS, "duty.log"), "utf8"); } catch { return ""; } })();
  const osa = (() => { try { return readFileSync(join(w, "osascript.log"), "utf8"); } catch { return ""; } })();
  const launcher = (() => { try { return readFileSync(join(BUS, "duty-launch.sh"), "utf8"); } catch { return ""; } })();
  const plist = (() => { try { return readFileSync(join(w, "Library", "LaunchAgents", "com.trantor.duty.plist"), "utf8"); } catch { return ""; } })();
  const lc = (() => { try { return readFileSync(LC, "utf8"); } catch { return ""; } })();
  return { osa, launcher, plist, lc, argv: existsSync(ARGV) ? readFileSync(ARGV, "utf8") : "", stdout: r.stdout || "", stderr: r.stderr || "", log };
}

console.log("\nThe triage seat pins its own model instead of inheriting yours:");
{
  const r = await dutyUp();
  ok("the seat actually started and ran a turn", r.argv.includes("-p") || r.argv.length > 0,
    `stdout: ${r.stdout.slice(0, 200)} stderr: ${r.stderr.slice(0, 600)}`);
  ok("the CLI is invoked WITH a --model flag (not the operator's default)", /--model\s+\S/.test(r.argv), JSON.stringify(r.argv.slice(0, 200)));
  ok("…and the default is a mid-tier model, not opus", /--model\s+sonnet/.test(r.argv), JSON.stringify(r.argv.slice(0, 200)));
  if (r.argv) console.log(`     ↳ invoked as: ${JSON.stringify(r.argv.trim().split("\n")[0].slice(0, 130))}`);
}

console.log("\nAnd the operator can still choose:");
{
  const r = await dutyUp(["--model", "haiku"]);
  ok("--model haiku is honoured", /--model\s+haiku/.test(r.argv), JSON.stringify(r.argv.slice(0, 160)));
}
{
  const r = await dutyUp([], { CREW_MODEL: "opus" });
  ok("an explicit CREW_MODEL still wins (escape hatch)", /--model\s+opus/.test(r.argv), JSON.stringify(r.argv.slice(0, 160)));
}
{
  const r = await dutyUp(["--model", "inherit"]);
  ok("--model inherit restores the old behaviour, with no flag at all",
    r.argv.length > 0 && !/--model/.test(r.argv), JSON.stringify(r.argv.slice(0, 160)));
}


console.log("\nA stranger who sees this window can tell what it is:");
{
  // An automatically opened window must explain its purpose and how to stop it.
  const r = await dutyUp();
  ok("the window names it in full: Trantor Duty Agent", /Trantor Duty Agent/.test(r.log), r.log.slice(0, 200));
  ok("…says what it does", /triage|watches|escalat/i.test(r.log), r.log.slice(0, 300));
  ok("…promises what it will NOT do", /never writes? code|does not write code/i.test(r.log), r.log.slice(0, 400));
  ok("…and says how to stop it", /trantor duty down/.test(r.log), r.log.slice(0, 400));
  ok("the bus id is self-describing, not the directory it happens to sit in",
    /claude:trantor-duty/.test(r.log + r.stdout), (r.stdout || "").slice(0, 160));
  ok("nothing still calls it \"fleet\"", !/:fleet|· fleet/.test(r.log + r.stdout), (r.log + r.stdout).slice(0, 200));
  const first = (r.log.match(/Trantor Duty Agent[^\n]*/) || [""])[0];
  if (first) console.log(`     ↳ window header: ${JSON.stringify(first.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 120))}`);
}


console.log("\nBy default the seat runs headless under a launchd keepalive:");
{
  // KeepAlive must restart duty after a crash, and up must describe the selected mode.
  const r = await dutyUp();
  ok("no window is opened", !/do script/.test(r.osa), r.osa.slice(0, 160));
  ok("a keepalive plist is installed", /KeepAlive/.test(r.plist) && /com\.trantor\.duty/.test(r.plist), r.plist.slice(0, 200));
  ok("…and launchd was told to load it now", /bootstrap/.test(r.lc) && /com\.trantor\.duty\.plist/.test(r.lc), r.lc.slice(0, 160));
  ok("the job runs the launcher, whose stdout lands in duty.log (launchd owns the seat)",
    /duty-launch\.sh/.test(r.plist) && /duty\.log/.test(r.plist), r.plist.slice(0, 300));
  ok("a crash cannot hot-loop the machine (ThrottleInterval is set)", /ThrottleInterval/.test(r.plist), r.plist.slice(0, 200));
  ok("the launcher still carries the rules, the model and the hub",
    r.launcher.length > 500 && /Trantor Duty Agent/.test(r.launcher) && /CREW_MODEL/.test(r.launcher) && /RELAY_URL/.test(r.launcher),
    `${r.launcher.length} chars`);
  ok("up SAYS the seat is headless under keepalive", /headless under the launchd keepalive/.test(r.stdout), r.stdout.slice(0, 200));
  ok("the seat actually ran under the keepalive (pid found, turn ran)", /pid [1-9]/.test(r.stdout) && /--model/.test(r.argv), r.stdout.slice(0, 140));
  // Backticks in the rules must survive Bash. Replace exec with a no-op and report lengths,
  // never dump the environment, which could disclose secrets.
  const probe = r.launcher.replace(/^exec .*$/m, ':');
  const { spawnSync: ss } = await import("node:child_process");
  const run = ss("/bin/bash", ["-c", `${probe}\nprintf "%s" "$RUNNER_RULES" | wc -c\nprintf "%s" "$RUNNER_TITLE"`], { encoding: "utf8" });
  const lines = (run.stdout || "").trim().split("\n");
  const rulesChars = Number(lines[lines.length - 2]);
  const title = lines[lines.length - 1] || "";
  ok("the launcher survives /bin/bash with the FULL rules intact (backtick regression)",
    run.status === 0 && rulesChars > 3000 && /Trantor Duty Agent/.test(title),
    `exit=${run.status} rulesChars=${rulesChars} titleLen=${title.length} stderrLen=${(run.stderr || "").length}`);
}

// #5694: the positive-PID cleanup guard makes window and headless legs safe to run together.

console.log("\n--window still gives you the visible surface, honestly labelled:");
{
  const r = await dutyUp(["--window"], { CREW_MUX: "terminal" });
  ok("a terminal window is opened for it", /Terminal/.test(r.osa) && /do script/.test(r.osa), r.osa.slice(0, 160));
  ok("the launcher never leaks the rules onto the command line", !/do script[^"]*You NEVER write code/.test(r.osa));
  ok("up says a window has NO keepalive", /NO keepalive/.test(r.stdout), r.stdout.slice(0, 200));
  ok("no keepalive plist is installed in window mode", !/KeepAlive/.test(r.plist), r.plist.slice(0, 200));
}

console.log("\nAnd --headless stays available as an explicit alias of the default:");
{
  const r = await dutyUp(["--headless"]);
  ok("--headless opens no window", !/do script/.test(r.osa), r.osa.slice(0, 120));
  ok("…and still installs the keepalive", /KeepAlive/.test(r.plist), r.plist.slice(0, 120));
}

hub.close();
hub.closeAllConnections?.();   // keep-alive sockets from the seat children must not hold the drill open
console.log(`\n${fail === 0 ? "✅" : "❌"} duty-seat: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

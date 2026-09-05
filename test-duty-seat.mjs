#!/usr/bin/env node
// trantor duty-model drill — the always-on triage seat must not silently inherit the operator's
// interactive model.
//
// Found 2026-08-24. bin/duty.mjs spawned crew-runner with only RELAY_URL, RUNNER_RULES and
// CREW_KICKOFF set. crew-runner reads CREW_MODEL, nothing set it, so the {M} placeholder stayed
// empty and the seat ran plain `claude -p …` with no --model flag. That takes the CLI default,
// which on this machine was opus[1m] at high effort: 1,457 turns and 66 hours of Opus in 23 days,
// for work whose own rules open "you NEVER write code" (read a message, run a patrol script, send
// a templated nudge, post 280 chars). Nobody chose it; it was inherited.
//
// The seat runs a REAL CLI, so this drill puts a fake `claude` on PATH that records its argv.
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "./drill-env.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
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
  writeFileSync(join(fakebin, "launchctl"), `#!/bin/sh
echo "$@" >> ${LC}
case "$1" in
  bootstrap)
    PL="$3"
    L=$(sed -n 's/.*<string>\\(.*duty-launch\\.sh\\)<\\/string>.*/\\1/p' "$PL" | head -1)
    O=$(sed -n 's/.*<string>\\(.*duty\\.log\\)<\\/string>.*/\\1/p' "$PL" | head -1)
    [ -n "$L" ] && nohup /bin/bash "$L" >> "\${O:-/dev/null}" 2>&1 &
    ;;
esac
exit 0
`);
  chmodSync(join(fakebin, "launchctl"), 0o755);
  writeFileSync(join(BUS, "config.json"), JSON.stringify({ url: HUB, ownerIdentity: "admin" }));

  // The drill tests duty's OWN model defaulting and launcher payload, so the invoking shell's
  // seat-injection vars must never reach it: run from a crew seat, `crew-runner` exports
  // CREW_MODEL (glm:trantor carries zai-coding-plan/glm-5.3-flash), and "…the default is a
  // mid-tier model" / "--model inherit" flip to false failures with no product bug behind them.
  // extraEnv below is the ONLY way these legitimately enter a leg (the CREW_MODEL escape-hatch
  // drill relies on that). Found 2026-08-31 running the drill from a seat shell.
  const baseEnv = { ...drillEnv() };
  for (const k of ["CREW_MODEL", "CREW_KICKOFF", "RUNNER_RULES", "RUNNER_TITLE", "RUNNER_ABOUT"]) delete baseEnv[k];

  // async spawn, never spawnSync: the mock hub lives in THIS process, so a synchronous child would
  // block the event loop that has to answer its requests, and duty would time out on its own probe.
  const r = await new Promise((resolve) => {
    const kid = spawn(process.execPath, [join(ROOT, "bin", "duty.mjs"), "up", "--hub", HUB, ...extraArgs], {
      stdio: ["ignore", "pipe", "pipe"],
      // Pin the surface to Terminal. These drills assert on the WINDOW the seat opens — its title,
      // what it says about itself — by stubbing osascript on PATH. Since 0.18.7 the seat prefers
      // cmux when one answers, so on a machine with cmux installed every one of those assertions
      // would test nothing and fail. CREW_MUX is the same override bin/crew.mjs uses.
      // The cmux path has its own drill below.
      env: { ...baseEnv, HOME: w, AGENT_BUS_DIR: BUS, PATH: `${fakebin}:${process.env.PATH}`,
             RELAY_URL: HUB, TRANTOR_NO_UPDATE_CHECK: "1", CREW_MUX: "terminal", ...extraEnv },
    });
    let so = "", se = "";
    kid.stdout.on("data", d => (so += d)); kid.stderr.on("data", d => (se += d));
    kid.on("close", () => resolve({ stdout: so, stderr: se }));
    setTimeout(() => { try { kid.kill("SIGKILL"); } catch {} }, 25000).unref?.();
  });
  await sleep(4500);                                  // let the kickoff turn actually run
  // Guard the pid: in --window mode the stubbed osascript never executes the launcher, so no
  // runner starts and duty writes 0 to the pidfile. process.kill(0, …) means "every process in
  // the CALLER's process group" (POSIX pid-0) — unguarded, this drill SIGKILLed its own group:
  // standalone it died silently mid-run; under `npm test` npm, sh, the suite runner and this file
  // all share one group, so the whole suite was killed at once and the invoking session sat
  // waiting on the dead pipeline — the "harness hang" these window legs were guarded behind
  // (2026-08-20 class suspicion was stdin; the mock-hub stdin paths are all stdio:"ignore" and
  // were never the mechanism).
  try { const pid = Number(readFileSync(join(BUS, "duty.pid"), "utf8")); if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGKILL"); } catch {}
  // The seat dir is trantor-duty now (identity-by-name, not "fleet") — a pkill aimed at the old
  // path leaked one live runner per harness run, and the leaked pack wedged the mock hub by the
  // --window block. Sweep the whole throwaway bus, not one hardcoded child dir.
  spawnSync("pkill", ["-f", `crew-runner.mjs claude ${BUS}`]);
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
  // Product concern, raised 2026-08-24: trantor installs, a terminal window opens by itself, and
  // it says "◤ CLAUDE ◢ trantor crew · fleet". Someone who does not already know what they are
  // looking at has no way to tell what just started on their machine, what it is doing, or how to
  // stop it. An unexplained agent window is alarming, and rightly so.
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
  // The 2026-08-27→31 incident: the window-open failed, the headless fallback printed one quiet
  // line, and the fleet had no watcher for four days. The default is now headless UNDER LAUNCHD
  // (KeepAlive), so a crash or reboot relaunches the seat instead of silently ending it — and
  // `up` says which mode it chose.
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
  // The launcher must SURVIVE /bin/bash — the rules carry backticks, and the old $(cat <<'EOF')
  // encoding silently dropped CREW_KICKOFF and RUNNER_RULES under macOS bash 3.2 (the seat ran
  // with the runner's generic kickoff and no triage rules at all). Regression lock: execute the
  // launcher (exec swapped for a no-op — `env` here DUMPED the whole environment to stdout and
  // the assertion read the dump's first line as its char count, a drill bug that indicted a
  // correct launcher) and require the full rules through the other side. Secrets stay out of the
  // failure detail: report lengths, never values.
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

// The --window and --headless-alias legs below were guarded behind TRANTOR_DRILL_WINDOW=1 for
// days as a "harness hang under the mock hub". Found 2026-08-31 while fixing #5694: there was no
// hang — the drill was killing itself. dutyUp() read the pidfile and called process.kill(pid)
// without guarding 0, and window mode legitimately has no runner (the stubbed osascript does not
// execute the launcher), so pid was 0 = "my own process group". Unguarded now; the pid guard in
// dutyUp() is the fix, and these legs always run.

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

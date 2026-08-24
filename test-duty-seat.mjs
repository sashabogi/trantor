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
// touch) and returns the argv the fake CLI was invoked with.
async function dutyUp(extraArgs = [], extraEnv = {}) {
  const w = mkdtempSync(join(tmpdir(), "tt-dutymodel-"));
  const BUS = join(w, "bus"); mkdirSync(join(BUS, "fleet"), { recursive: true });
  const fakebin = join(w, "bin"); mkdirSync(fakebin, { recursive: true });
  const ARGV = join(w, "argv.log");
  writeFileSync(join(fakebin, "claude"), `#!/bin/sh\necho "$@" >> ${ARGV}\nexit 0\n`);
  chmodSync(join(fakebin, "claude"), 0o755);
  writeFileSync(join(BUS, "config.json"), JSON.stringify({ url: HUB, ownerIdentity: "admin" }));

  // async spawn, never spawnSync: the mock hub lives in THIS process, so a synchronous child would
  // block the event loop that has to answer its requests, and duty would time out on its own probe.
  const r = await new Promise((resolve) => {
    const kid = spawn(process.execPath, [join(ROOT, "bin", "duty.mjs"), "up", "--hub", HUB, ...extraArgs], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: w, AGENT_BUS_DIR: BUS, PATH: `${fakebin}:${process.env.PATH}`,
             RELAY_URL: HUB, TRANTOR_NO_UPDATE_CHECK: "1", ...extraEnv },
    });
    let so = "", se = "";
    kid.stdout.on("data", d => (so += d)); kid.stderr.on("data", d => (se += d));
    kid.on("close", () => resolve({ stdout: so, stderr: se }));
    setTimeout(() => { try { kid.kill("SIGKILL"); } catch {} }, 25000).unref?.();
  });
  await sleep(4500);                                  // let the kickoff turn actually run
  try { const pid = Number(readFileSync(join(BUS, "duty.pid"), "utf8")); process.kill(pid, "SIGKILL"); } catch {}
  spawnSync("pkill", ["-f", `crew-runner.mjs claude ${join(BUS, "fleet")}`]);
  const log = (() => { try { return readFileSync(join(BUS, "duty.log"), "utf8"); } catch { return ""; } })();
  return { argv: existsSync(ARGV) ? readFileSync(ARGV, "utf8") : "", stdout: r.stdout || "", stderr: r.stderr || "", log };
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

hub.close();
console.log(`\n${fail === 0 ? "✅" : "❌"} duty-seat: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

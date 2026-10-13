#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "../drill-env.mjs";
import { seatSignalPrefix } from "../../lib/seat-signal-guard.mjs";

const self = fileURLToPath(import.meta.url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0;
function check(value, message) { assert.ok(value, message); passed++; }

async function namedChild(name) {
  const child = spawn(process.execPath, ["-e", "process.title=process.argv[1]; process.send('ready'); setInterval(() => {}, 1000)", name],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  await once(child, "message");
  return child;
}

async function fixture() {
  const run = (shell, command) => spawnSync(shell, ["-lc", command], { encoding: "utf8" });
  const shells = ["/bin/bash", ...existsSync("/bin/zsh") ? ["/bin/zsh"] : []];
  const child = await namedChild("claude");
  const exited = once(child, "exit");
  try {
    for (const shell of shells) {
      // Never exercise broad commands unless resolution proves they are our guarded scripts.
      for (const name of ["pkill", "killall", "kill"]) {
        const resolved = run(shell, `command -v ${name}`).stdout.trim();
        check(resolved.includes("/.agent-bus-out/signal-guard/"), `${shell}: ${name} resolves to guard: ${resolved}`);
      }
      for (const cmd of [
        'pkill -f "claude" -0', "killall claude", 'pkill -f "claude"', 'pkill -0 -f "claude"',
        `kill ${process.env.DECOY_PID}`, `kill ${process.env.TRANTOR_SIGNAL_ROOT}`,
        `kill ${child.pid} ${process.env.DECOY_PID}`, "kill 0", "kill -- -1",
      ]) {
        const result = run(shell, cmd);
        check(result.status !== 0 && /^seat signal guard: refused .*\n$/.test(result.stderr), `${shell}: ${cmd}: ${result.stderr}`);
        process.kill(Number(process.env.DECOY_PID), 0);
        process.kill(child.pid, 0);
      }
      const probe = run(shell, `kill -0 ${child.pid}`);
      check(probe.status === 0, `${shell}: own child signal zero works: ${probe.stderr}`);
    }
    const terminated = run("/bin/bash", `kill ${child.pid}`);
    check(terminated.status === 0, `own child kill allowed: ${terminated.stderr}`);
    const [, signal] = await exited;
    check(signal === "SIGTERM", "own child received SIGTERM");
    const patternChild = await namedChild(`owned-${process.pid}`);
    const patternExited = once(patternChild, "exit");
    try {
      const probe = run("/bin/bash", `pkill -0 -fi '^OWNED-${process.pid}'`);
      check(probe.status === 0, `combined pattern options work: ${probe.stderr}`);
      const result = run("/bin/bash", `pkill -f '^owned-${process.pid}'`);
      check(result.status === 0, `own child pattern allowed: ${result.stderr}`);
      check((await patternExited)[1] === "SIGTERM", "pattern child received SIGTERM");
    } finally { if (patternChild.exitCode === null && patternChild.signalCode === null) patternChild.kill(); }
    const named = await namedChild(`owned-${process.pid}`);
    const namedExit = once(named, "exit");
    try {
      const result = run("/bin/bash", `killall owned-${process.pid}`);
      check(result.status === 0, `owned killall allowed: ${result.stderr}`);
      check((await namedExit)[1] === "SIGTERM", "killall child received SIGTERM");
    } finally { if (named.exitCode === null && named.signalCode === null) named.kill(); }
    writeFileSync(process.env.RESULT, JSON.stringify({ passed }));
    console.log("Signal guard verified: outside targets refused atomically, own children terminated, and the operator decoy survived all shell commands.");
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
}

if (process.argv.includes("--fixture")) {
  await fixture();
} else {
  const out = resolve(".agent-bus-out"); mkdirSync(out, { recursive: true });
  const work = mkdtempSync(join(out, "signal-test-"));
  const repository = join(work, "clean-repo"); mkdirSync(repository);
  check(spawnSync("git", ["init", "-q", repository]).status === 0, "created repository without ignore rules");
  seatSignalPrefix(repository);
  const status = spawnSync("git", ["-C", repository, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
  check(status.status === 0 && status.stdout === "", "runtime shims never count as uncommitted seat work");
  const decoy = await namedChild("claude");
  const decoyExit = once(decoy, "exit");
  const hub = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const path = new URL(req.url, "http://fixture").pathname;
      const body = path === "/poll" || path === "/inbox" ? { messages: [], cursor: 0 }
        : path === "/lessons" ? { lessons: [] } : { ok: true };
      const reply = () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (path === "/poll") setTimeout(reply, 100); else reply();
    });
  });
  await new Promise(resolve => hub.listen(0, "127.0.0.1", resolve));
  try {
    for (const agent of ["codex", "claude", "glm"]) {
      const seat = join(work, agent); mkdirSync(seat);
      const home = join(seat, "home"); mkdirSync(join(home, ".agent-bus"), { recursive: true });
      const bin = join(seat, "bin"); mkdirSync(bin);
      const fake = agent === "glm" ? "opencode" : agent;
      writeFileSync(join(bin, fake), `#!/bin/sh\nexec '${process.execPath}' '${self}' --fixture\n`, { mode: 0o755 });
      const result = join(seat, "result.json");
      let log = "";
      const runner = spawn(process.execPath, ["bin/crew-runner.mjs", agent, seat], {
        env: drillEnv({ HOME: home, PATH: `${bin}:${process.env.PATH}`,
          DECOY_PID: String(decoy.pid), RESULT: result, RELAY_PROJECT: "signal-drill",
          RELAY_URL: `http://127.0.0.1:${hub.address().port}`, TRANTOR_TURN_MAX_MS: "0",
          CREW_KICKOFF: "Run the signal fixture and end the turn." }), stdio: ["ignore", "pipe", "pipe"],
      });
      runner.stdout.on("data", bytes => { log += bytes; });
      runner.stderr.on("data", bytes => { log += bytes; });
      const runnerExit = once(runner, "exit");
      try {
        const deadline = Date.now() + 120000;
        while (!existsSync(result) && runner.exitCode === null && Date.now() < deadline) await pause(50);
        check(existsSync(result), `${agent}: real runner completed regression\n${log}`);
        passed += JSON.parse(readFileSync(result, "utf8")).passed;
        process.kill(decoy.pid, 0);
        check(runner.exitCode === null, `${agent}: runner survives`);
        console.log(`PASS ${agent}: inherited guard through real runner`);
        // Allow the runner's turn to finish so its watchdog exits normally.
        await pause(1200);
      } finally {
        runner.kill("SIGTERM"); await runnerExit;
      }
    }
    console.log(`seat signal guard: ${passed} checks passed`);
  } finally {
    decoy.kill("SIGTERM"); await decoyExit;
    await new Promise(resolve => hub.close(resolve));
    rmSync(work, { recursive: true, force: true });
  }
}

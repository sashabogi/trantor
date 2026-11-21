import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { drillEnv } from "../drill-env.mjs";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const OUT = join(ROOT, ".agent-bus-out");
const WRAPPER = join(ROOT, "bin", "heavy-gate.mjs");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
mkdirSync(OUT, { recursive: true });

function workspace(t, slots) {
  const dir = mkdtempSync(join(OUT, "heavy-gate-test-"));
  const bus = join(dir, "bus");
  mkdirSync(bus, { recursive: true });
  writeFileSync(join(bus, "config.json"), JSON.stringify({ heavyGateSlots: slots }));
  const fixture = join(dir, "fixture.mjs");
  writeFileSync(fixture, `import { writeFileSync } from "node:fs";
const [id, duration] = process.argv.slice(2);
writeFileSync(new URL(id + ".start", import.meta.url), JSON.stringify({ pid: process.pid, at: Date.now() }));
setTimeout(() => {
  writeFileSync(new URL(id + ".end", import.meta.url), JSON.stringify({ at: Date.now() }));
}, Number(duration));
`);
  t.after(() => {
    for (const name of readdirSync(dir).filter(name => name.endsWith(".start"))) {
      try { process.kill(JSON.parse(readFileSync(join(dir, name), "utf8")).pid, "SIGKILL"); } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const env = drillEnv({ AGENT_BUS_DIR: bus });
  delete env.TRANTOR_HEAVY_GATE_HELD;
  delete env.TRANTOR_HEAVY_GATE_WAIT_DIR;
  return { dir, bus, fixture, env };
}

function gated(workspace, id, duration, extra = {}) {
  const child = spawn(process.execPath, [WRAPPER, "--", process.execPath, workspace.fixture, id, String(duration)], {
    env: { ...workspace.env, ...extra.env }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const done = new Promise(resolve => child.on("close", (code, signal) => resolve({ code, signal, output })));
  return { child, done, output: () => output };
}

async function waitFor(path, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!existsSync(path)) {
    if (Date.now() >= end) throw new Error(`timed out waiting for ${path}`);
    await sleep(25);
  }
}

function timing(dir, id, kind) {
  return JSON.parse(readFileSync(join(dir, `${id}.${kind}`), "utf8"));
}

test("two slots run three commands at most two at once and queue the third", async t => {
  const w = workspace(t, 2);
  const runs = ["a", "b", "c"].map(id => gated(w, id, 500));
  const results = await Promise.all(runs.map(run => run.done));
  assert.ok(results.every(result => result.code === 0), JSON.stringify(results));
  const events = ["a", "b", "c"].flatMap(id => [
    { at: timing(w.dir, id, "start").at, delta: 1 },
    { at: timing(w.dir, id, "end").at, delta: -1 },
  ]).sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0, peak = 0;
  for (const event of events) {
    active += event.delta;
    peak = Math.max(peak, active);
  }
  assert.equal(peak, 2);
  const ends = ["a", "b", "c"].map(id => timing(w.dir, id, "end").at);
  const starts = ["a", "b", "c"].map(id => timing(w.dir, id, "start").at);
  assert.ok(Math.max(...starts) >= Math.min(...ends), "the third command starts only after a holder finishes");
  assert.equal(results.filter(result => result.output.includes("waiting for a heavy-gate slot (2 in use)")).length, 1);
});

test("a SIGKILLed holder releases its kernel lock", async t => {
  const w = workspace(t, 1);
  const holder = gated(w, "holder", 30000);
  await waitFor(join(w.dir, "holder.start"));
  const holderPid = timing(w.dir, "holder", "start").pid;
  process.kill(holderPid, "SIGKILL");
  const stopped = await holder.done;
  assert.notEqual(stopped.code, 0);
  const next = gated(w, "next", 100);
  await waitFor(join(w.dir, "next.start"), 3000);
  assert.equal((await next.done).code, 0);
});

test("a nested gate inherits its parent's slot instead of deadlocking", async t => {
  const w = workspace(t, 1);
  const holder = gated(w, "outer", 1200);
  await waitFor(join(w.dir, "outer.start"));
  const nested = gated(w, "nested", 100, { env: { TRANTOR_HEAVY_GATE_HELD: "1" } });
  await waitFor(join(w.dir, "nested.start"), 1500);
  assert.equal((await nested.done).code, 0);
  assert.equal((await holder.done).code, 0);
});

test("the cargo shim gates build but lets light cargo subcommands through", async t => {
  const w = workspace(t, 1);
  const fakeBin = join(w.dir, "fake-bin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "cargo"), `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const id = "cargo-" + (process.argv.includes("build") ? "build" : "check");
writeFileSync(new URL("../" + id + ".start", import.meta.url), JSON.stringify({ pid: process.pid, at: Date.now() }));
setTimeout(() => writeFileSync(new URL("../" + id + ".end", import.meta.url), JSON.stringify({ at: Date.now() })), 100);
`, { mode: 0o755 });
  const holder = gated(w, "cargo-holder", 900);
  await waitFor(join(w.dir, "cargo-holder.start"));
  const env = { ...w.env, PATH: `${join(ROOT, "bin", "heavy-gate-shim")}:${fakeBin}:${w.env.PATH}` };
  const cargo = (...args) => {
    const child = spawn(join(ROOT, "bin", "heavy-gate-shim", "cargo"), args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    return { done: new Promise(resolve => child.on("close", code => resolve({ code, output }))), output: () => output };
  };
  const check = cargo("check");
  const build = cargo("--manifest-path", "ignored", "build");
  await waitFor(join(w.dir, "cargo-check.start"), 1500);
  assert.equal(existsSync(join(w.dir, "cargo-build.start")), false, "cargo build waits for the heavy holder");
  assert.equal((await check.done).code, 0);
  assert.equal((await holder.done).code, 0);
  assert.equal((await build.done).code, 0);
  assert.ok(timing(w.dir, "cargo-build", "start").at >= timing(w.dir, "cargo-holder", "end").at);
  assert.match(build.output(), /waiting for a heavy-gate slot \(1 in use\)/);
});

test("npx vitest run is gated by the seat shim", async t => {
  const w = workspace(t, 1);
  const fakeBin = join(w.dir, "fake-npx");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "npx"), `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(new URL("../npx-vitest.start", import.meta.url), JSON.stringify({ pid: process.pid, at: Date.now() }));
setTimeout(() => writeFileSync(new URL("../npx-vitest.end", import.meta.url), JSON.stringify({ at: Date.now() })), 100);
`, { mode: 0o755 });
  const holder = gated(w, "npx-holder", 700);
  await waitFor(join(w.dir, "npx-holder.start"));
  const env = { ...w.env, PATH: `${join(ROOT, "bin", "heavy-gate-shim")}:${fakeBin}:${w.env.PATH}` };
  const child = spawn(join(ROOT, "bin", "heavy-gate-shim", "npx"), ["vitest", "run"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const done = new Promise(resolve => child.on("close", code => resolve(code)));
  assert.equal(existsSync(join(w.dir, "npx-vitest.start")), false);
  assert.equal((await holder.done).code, 0);
  assert.equal(await done, 0);
  assert.ok(timing(w.dir, "npx-vitest", "start").at >= timing(w.dir, "npx-holder", "end").at);
  assert.match(output, /waiting for a heavy-gate slot \(1 in use\)/);
});

test("queued gates move the watchdog deadline and do not count as silence", async t => {
  const w = workspace(t, 1);
  const stamp = join(w.dir, "stamp.json");
  const err = join(w.dir, "err.txt");
  const stall = join(w.dir, "stall");
  const turnState = join(w.dir, "turnstate.json");
  const waitDir = join(w.dir, "wait");
  const workDir = join(w.dir, "work");
  const deadlineFile = join(workDir, ".agent-bus", "deadline");
  mkdirSync(waitDir);
  mkdirSync(join(workDir, ".agent-bus"), { recursive: true });
  writeFileSync(err, "");
  const startedAt = Date.now();
  writeFileSync(stamp, JSON.stringify({
    turn: 1, startedAt, runner: `${process.pid}.1`,
    box: { maxMs: 1000, extendMs: 500, ceilingMs: 1000, extensionsMax: 0, deadlineFile, extFile: join(w.dir, "extensions") },
  }));
  const watchdog = spawn(process.execPath, [join(ROOT, "bin", "turn-watchdog.mjs"), stamp, err, "400", "seat:proj", "proj", "http://127.0.0.1:1", "", workDir, stall, turnState, waitDir], {
    env: drillEnv(), stdio: "ignore",
  });
  t.after(() => { try { watchdog.kill("SIGKILL"); } catch {} });
  const record = join(waitDir, "wait.json");
  const waitStart = Date.now();
  const interval = setInterval(() => {
    writeFileSync(record, JSON.stringify({ pid: process.pid, waiting: true, updatedAt: Date.now(), totalMs: Date.now() - waitStart }));
  }, 100);
  await sleep(1400);
  clearInterval(interval);
  assert.equal(existsSync(stall), false, "a queued gate must not trip the stall watchdog");
  const waitedMs = Date.now() - waitStart;
  writeFileSync(record, JSON.stringify({ pid: process.pid, waiting: false, updatedAt: Date.now(), totalMs: waitedMs }));
  const deadline = Number(readFileSync(deadlineFile, "utf8")) * 1000;
  assert.ok(deadline >= startedAt + 1000 + waitedMs - 1100, `deadline ${deadline}, start ${startedAt}, wait ${waitedMs}`);
  await waitFor(stall, 4000);
});

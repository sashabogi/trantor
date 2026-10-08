import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { performSwap, pendingPath, swapOptions, validateReplacement } from "../../bin/crew/swap.mjs";
import { providerStatus } from "../../lib/providers.mjs";
import { runnerRecord, seatProcesses, signalProcesses } from "../../bin/crew/processes.mjs";
import { spawnCmux } from "../../bin/crew/cmux.mjs";
import { spawnHerdr } from "../../bin/crew/herdr.mjs";
import { startTestHub } from "../lib/test-hub.mjs";
import { drillEnv } from "../drill-env.mjs";

const root = resolve(".agent-bus-out");
mkdirSync(root, { recursive: true });
const home = mkdtempSync(join(root, "swap-test-"));
const fakebin = join(home, "bin");
mkdirSync(fakebin);
mkdirSync(join(home, ".agent-bus"));
const env = drillEnv({ HOME: home, AGENT_BUS_DIR: join(home, ".agent-bus"), PATH: `${fakebin}:/usr/bin:/bin`, TRANTOR_NO_KEYCHAIN: "1", TRANTOR_SECRETS_BACKEND: "file", CREW_NO_PROC_KILL: "1", CREW_MUX: "tmux", RELAY_PROJECT: "swap-drill", PWD: home });
for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET/.test(key) && key !== "TRANTOR_SECRETS_BACKEND") delete env[key];
for (const binary of ["codex", "opencode", "python3", "tmux", "osascript"]) {
  const output = binary === "opencode" ? "echo openrouter/test-model" : binary === "python3" ? `echo '{"qualified":"openrouter/test-model"}'` : "exit 0";
  writeFileSync(join(fakebin, binary), `#!/bin/sh\n${output}\n`, { mode: 0o755 });
}
const hub = await startTestHub({ dir: join(home, "hub"), env: { RELAY_AUTH: "off" } });
const ctx = { home, env, project: "swap-drill", seatDir: join(home, ".agent-bus/seats"), hub: hub.base, root: resolve("."), dir: home };
const post = async (path, body) => {
  const response = await fetch(hub.base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
};
const get = async path => (await fetch(hub.base + path)).json();
const ledger = () => get("/contracts?session=orch:swap-drill&project=swap-drill");
const register = session => post("/register", { session, project: ctx.project, kind: "agent" });
const send = (to, text) => post("/send", { from: "orch:swap-drill", to, text, project: ctx.project });
let checks = 0;
function check(name, test) { assert.ok(test, name); checks++; console.log(`✓ ${name}`); }
function cli(args, extra = {}) {
  return new Promise(resolveRun => {
    const child = spawn(process.execPath, ["bin/crew.mjs", ...args], { env: { ...env, RELAY_URL: hub.base, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => resolveRun({ code, stdout, stderr, result: JSON.parse(stdout) }));
  });
}
const status = opts => providerStatus({ ...opts, home, probe: async provider => ({ provider, ok: true, kind: "prepaid", balance: 1 }) });
const children = [];
try {
  const muxLog = join(home, "mux.log");
  for (const binary of ["cmux", "herdr"]) writeFileSync(join(fakebin, binary), `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(muxLog)}, process.argv.slice(2).join(' ') + '\\n');\nconsole.log('[]');\n`, { mode: 0o755 });
  const statePath = join(home, ".agent-bus/crew-windows.txt");
  const tracked = "swap-drill\tcmuxws\t__ws__\told-cmux\nswap-drill\tcmuxws\t__ws__\tnew-cmux\nswap-drill\therdrws\t__ws__\told-herdr\nswap-drill\therdrws\t__ws__\tnew-herdr\n";
  writeFileSync(statePath, tracked);
  const muxCtx = { ...ctx, statePath, have: { cmux: true, herdr: true }, swap: { label: "temporary" } };
  spawnCmux(muxCtx, [], () => null, () => {});
  try { spawnHerdr(muxCtx, [], () => null, () => {}); } catch (error) { assert.match(error.message, /no live pane/); }
  spawnCmux({ ...muxCtx, have: { cmux: false } }, [], () => null, () => {});
  check("staged mux launch never cleans up existing workspaces even when spawning fails", readFileSync(statePath, "utf8") === tracked && !readFileSync(muxLog, "utf8").includes("close"));
  writeFileSync(statePath, "");
  await register("kimi:swap-drill");
  const held = await send("kimi:swap-drill", "contract: implement card #11221");
  const owed = await send("kimi:swap-drill", "contract: queued work");
  const answered = await send("kimi:swap-drill", "already handled");
  await post("/send", { from: "kimi:swap-drill", to: "orch:swap-drill", project: ctx.project, text: "finished", re: answered.id });
  writeFileSync(pendingPath(ctx, "kimi"), JSON.stringify({ wake: [{ ...held, from: "orch:swap-drill", to: "kimi:swap-drill", text: "contract: implement card #11221" }], bcast: [], seen: [], ask: 0 }));
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex/auth.json"), JSON.stringify({ tokens: { access_token: "fake-for-test" } }));
  const order = [];
  const runtime = {
    validate: options => validateReplacement(ctx, options, status),
    async start(seat, stage) { order.push("start"); await register(`${stage.label}:${ctx.project}`); },
    async ready(stage) { order.push("ready"); return `${stage.label}:${ctx.project}`; },
    freeze() { order.push("freeze"); },
    resume() { order.push("resume"); },
    transfer(body) { order.push("transfer"); return post("/contracts/transfer", body); },
    stop() {
      order.push("stop");
      const pending = JSON.parse(readFileSync(pendingPath(ctx, "codex")));
      check("replacement queue is durable before old seat stops", pending.wake.length === 2);
    },
    release() { order.push("release"); },
    cancel() { order.push("cancel"); },
  };
  const swapped = await performSwap(ctx, swapOptions(["kimi", "codex"]), runtime);
  check("happy swap moved pending and hub-only contracts", swapped.ok && swapped.moved.includes(held.id) && swapped.moved.includes(owed.id) && !swapped.moved.includes(answered.id));
  check("startup, readiness and transfer precede teardown", order.join(",") === "start,ready,freeze,transfer,stop,release");
  check("hub ownership changed without losing original message ids", (await ledger()).contracts.filter(c => swapped.moved.includes(c.id)).every(c => c.to === "codex:swap-drill"));
  check("old pending queue is drained", JSON.parse(readFileSync(pendingPath(ctx, "kimi"))).wake.length === 0);
  await post("/send", { from: "codex:swap-drill", to: "orch:swap-drill", text: "done", project: ctx.project, re: held.id });
  check("replacement reply settles original sender's contract", (await ledger()).contracts.find(c => c.id === held.id).answered);

  order.length = 0;
  const bad = await performSwap(ctx, swapOptions(["codex", "--provider", "openrouter"]), runtime);
  check("missing key rejects same-agent provider swap before lifecycle mutations", !bad.ok && /credential/.test(bad.reason) && order.length === 0);
  const badKeyStatus = opts => providerStatus({ ...opts, home, env: { ...opts.env, OPENROUTER_API_KEY: "fake-rejected" }, probe: async () => ({ ok: false, error: "401 invalid key" }) });
  const rejected = await performSwap(ctx, swapOptions(["codex", "--provider", "openrouter"]), { ...runtime, validate: options => validateReplacement(ctx, options, badKeyStatus) });
  check("rejected key leaves old seat untouched", !rejected.ok && /rejected/.test(rejected.reason) && order.length === 0);
  const same = await performSwap(ctx, swapOptions(["codex", "codex", "--provider", "openrouter"]), {
    ...runtime,
    validate: options => validateReplacement({ ...ctx, env: { ...env, OPENROUTER_API_KEY: "fake-test-key" } }, options, status),
    stop() { order.push("stop"); },
  });
  check("same-agent provider swap succeeds with concrete model", same.ok && same.seat === "codex" && same.to === "codex");
  order.length = 0;
  const timeout = await performSwap(ctx, swapOptions(["kimi", "codex"]), { ...runtime, ready() { throw new Error("not on bus"); } });
  check("readiness failure cancels only replacement", !timeout.ok && order.join(",") === "start,cancel");
  order.length = 0;
  const failedTransfer = await performSwap(ctx, swapOptions(["kimi", "codex"]), { ...runtime, transfer() { throw new Error("hub unavailable"); } });
  check("transfer failure resumes old seat and cancels replacement", !failedTransfer.ok && order.join(",") === "start,ready,freeze,resume,cancel");
  order.length = 0;
  const invalidModel = await performSwap(ctx, swapOptions(["kimi", "codex", "--model", "not-a-model"]), runtime);
  check("invalid model is refused before startup", !invalidModel.ok && /model/.test(invalidModel.reason) && order.length === 0);
  const missingCli = await performSwap(ctx, swapOptions(["codex", "kimi"]), runtime);
  check("missing CLI is refused before startup", !missingCli.ok && /CLI not found/.test(missingCli.reason) && order.length === 0);

  const questionContract = await send("kimi:swap-drill", "contract: blocked work");
  const question = await post("/send", { from: "kimi:swap-drill", to: "orch:swap-drill", text: "which target?", project: ctx.project, kind: "ask", re: questionContract.id });
  writeFileSync(pendingPath(ctx, "kimi"), JSON.stringify({ wake: [], bcast: [], seen: [], ask: question.id, askTo: "orch:swap-drill" }));
  const heldAsk = await performSwap(ctx, swapOptions(["kimi", "codex"]), { ...runtime, stop() {} });
  const restored = JSON.parse(readFileSync(pendingPath(ctx, "codex")));
  check("held ask metadata survives handoff", heldAsk.ok && restored.ask === question.id && restored.askTo === "orch:swap-drill");
  const questions = await get("/contracts?session=codex:swap-drill&project=swap-drill");
  check("held ask now belongs to replacement's ledger", questions.contracts.some(c => c.id === question.id && c.kind === "ask"));
  const crossed = await fetch(hub.base + "/contracts/transfer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "codex:swap-drill", to: "codex:other-project", project: ctx.project }) });
  check("transfer refuses cross-project destination", crossed.status === 400);

  for (const args of [["down", "codex", "--json"], ["up", "codex", "--json"]]) {
    const command = await cli(args, { CREW_DRY_RUN: "1" });
    check(`${args[0]} stdout is a single JSON result`, command.code === 0 && command.result.ok && command.result.action === args[0] && command.result.seat === "codex" && Array.isArray(command.result.moved));
  }
  const failure = await cli(["swap", "codex", "--provider", "openrouter", "--json"]);
  check("swap failure has scriptable JSON and nonzero exit", failure.code === 1 && failure.result.action === "swap" && failure.result.seat === "codex" && failure.result.to === "codex" && failure.result.moved.length === 0 && /credential/.test(failure.result.reason));

  const stage = join(home, "staged");
  const stageChild = spawn(process.execPath, ["--input-type=module", "-e", `import { awaitSwapRelease } from './bin/crew/stage.mjs'; await awaitSwapRelease();`], {
    env: { ...env, RELAY_URL: hub.base, CREW_SWAP_STAGE: stage, CREW_SWAP_LABEL: "staging", CREW_SWAP_AGENT: "codex" }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(stageChild);
  const deadline = Date.now() + 10000;
  while (!existsSync(`${stage}.ready`) && stageChild.exitCode === null && Date.now() < deadline) await setTimeout(50);
  check("staged runner registers without running a CLI", existsSync(`${stage}.ready`) && stageChild.exitCode === null);
  check("staging identity is visible on test bus", (await get("/peers")).peers.some(p => p.session === "staging:swap-drill"));
  writeFileSync(`${stage}.release`, JSON.stringify({ agent: "codex" }));
  const code = await new Promise(resolveExit => stageChild.once("exit", resolveExit));
  check("staged runner proceeds only after handoff release", code === 0);

  const fakeRunner = join(fakebin, "crew-runner.mjs");
  writeFileSync(fakeRunner, "setInterval(() => {}, 1000);\n");
  const old = spawn(process.execPath, [fakeRunner, "old-swap-label", home], { stdio: "ignore" });
  const replacement = spawn(process.execPath, [fakeRunner, "new-swap-label", home], { stdio: "ignore" });
  children.push(old, replacement);
  writeFileSync(runnerRecord(ctx, ctx.project, "codex"), JSON.stringify({ label: "old-swap-label", dir: home }));
  const processCtx = { ...ctx, env: { ...ctx.env, CREW_NO_PROC_KILL: "0" } };
  const pids = seatProcesses(processCtx, ctx.project, "codex");
  check("second swap finds the promoted runner without selecting its replacement", pids.includes(old.pid) && !pids.includes(replacement.pid));
  signalProcesses(pids, "SIGKILL");
  check("replacement survives old runner teardown", replacement.exitCode === null);

  const runnerProject = "swap-runner-drill";
  const invocationLog = join(home, "invocations.log");
  writeFileSync(join(fakebin, "opencode"), `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nconsole.log('The isolated replacement processed its handed-off request and recorded the concrete result for the test runner.');\n`, { mode: 0o755 });
  const runnerStage = join(home, "runner-stage");
  const realRunner = spawn(process.execPath, ["bin/crew-runner.mjs", "codex-swap-test", home], {
    env: { ...env, RELAY_PROJECT: runnerProject, RELAY_URL: hub.base, CREW_SWAP_STAGE: runnerStage, CREW_SWAP_LABEL: "codex-swap-test", CREW_SWAP_AGENT: "codex", CREW_SWAP_DRIVER: "opencode", CREW_MODEL: "openrouter/test-model", TRANTOR_NO_UPDATE_CHECK: "1" },
    detached: true, stdio: "ignore",
  });
  children.push(realRunner);
  try {
    const readyDeadline = Date.now() + 10000;
    while (!existsSync(`${runnerStage}.ready`) && realRunner.exitCode === null && Date.now() < readyDeadline) await setTimeout(50);
    check("real runner waits before opening the provider CLI", existsSync(`${runnerStage}.ready`) && !existsSync(invocationLog));
    const work = await post("/send", { from: `orch:${runnerProject}`, to: `codex:${runnerProject}`, project: runnerProject, text: "contract: uniquely-carried-swap-work" });
    writeFileSync(pendingPath({ ...ctx, project: runnerProject }, "codex"), JSON.stringify({ wake: [{ id: work.id, from: `orch:${runnerProject}`, to: `codex:${runnerProject}`, text: "contract: uniquely-carried-swap-work", project: runnerProject }], bcast: [], seen: [] }));
    writeFileSync(`${runnerStage}.release`, JSON.stringify({ agent: "codex", cursor: work.id }));
    const wakeDeadline = Date.now() + 20000;
    while ((!existsSync(invocationLog) || !readFileSync(invocationLog, "utf8").includes("uniquely-carried-swap-work")) && realRunner.exitCode === null && Date.now() < wakeDeadline) await setTimeout(100);
    const invocations = existsSync(invocationLog) ? readFileSync(invocationLog, "utf8") : "";
    check("same-agent provider runner executes the handed-off contract through opencode", invocations.includes("uniquely-carried-swap-work") && invocations.includes("openrouter/test-model"));
    check("replacement uses canonical seat identity on bus", (await get(`/peers?project=${runnerProject}`)).peers.some(p => p.session === `codex:${runnerProject}`));
  } finally { try { process.kill(-realRunner.pid, "SIGKILL"); } catch {} }
  console.log(`${checks} passed, 0 failed`);
} finally {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  await hub.stop();
  rmSync(home, { recursive: true, force: true });
}

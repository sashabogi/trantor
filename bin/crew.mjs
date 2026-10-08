#!/usr/bin/env node
import { seatProcesses } from "./crew/processes.mjs";
import { allocatePersona } from "../lib/persona.mjs";
import { join } from "node:path";
import { call, createContext } from "./crew/core.mjs";
import { createCmuxAdapter, spawnCmux } from "./crew/cmux.mjs";
import { createHerdrAdapter, spawnHerdr } from "./crew/herdr.mjs";
import { resolveSpec, reportSkipped } from "./crew/models.mjs";
import { openOrchestrator } from "./crew/open.mjs";
import { performSwap, swapOptions, swapRuntime } from "./crew/swap.mjs";
import { redactKeys } from "../lib/redact.mjs";
import { reapSeat, down, prune, readRows } from "./crew/state.mjs";
import { spawnTerminal, spawnTmux } from "./crew/tmux.mjs";
import { epochMs, failedAgents, verifyCrew } from "./crew/verify.mjs";
import { guardCrossProjectUp } from "./crew/worktrees.mjs";
import { preflightFirstSeat } from "./crew/preflight.mjs";
import { resolveAgentLaunchSpecs } from "../lib/agent-preferences.mjs";
import { readConfig } from "../lib/project.mjs";

const [command = "up", ...inputArgs] = process.argv.slice(2);
const jsonMode = inputArgs.includes("--json");
const rawArgs = inputArgs.filter(arg => arg !== "--json");
const output = console.log.bind(console);
const diagnostics = [];
if (jsonMode) console.log = (...parts) => {
  const line = redactKeys(parts.join(" "));
  diagnostics.push(line);
  console.error(line);
};
const jsonResult = (code, extra = {}) => ({ ok: code === 0, action: command, seat: resultSeat, moved: [], ...extra });
let resultSeat = rawArgs.filter(a => !a.startsWith("--")).join(",");
let ctx;
try { ctx = createContext(command); }
catch (error) { if (jsonMode) output(JSON.stringify(jsonResult(1, { reason: redactKeys(error.message) }))); else console.error(error.message); process.exit(1); }

const adapters = {
  cmux: createCmuxAdapter(ctx),
  herdr: createHerdrAdapter(ctx),
};

function usage() {
  console.log("usage: crew.mjs up <agent...> | crew.mjs open [<project>] | crew.mjs swap <old> <new[:provider[/model]]> | crew.mjs down [<agent>...] [--all --yes] | crew.mjs prune");
}

function parseUpArgs(args) {
  const result = { task: "code", difficulty: "medium", specs: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--task") result.task = args[++index] || "code";
    else if (arg === "--difficulty" || arg === "--diff") result.difficulty = args[++index] || "medium";
    else if (arg === "--as") {
      result.persona = args[++index];
      if (!result.persona) throw new Error("--as requires a persona name");
    } else result.specs.push(arg);
  }
  return result;
}

function spawnCrew(options, skipped) {
  const resolve = seat => { reapSeat(ctx, seat.persona); return seat; };
  const pruneNow = () => prune(ctx, adapters);
  if (ctx.mux === "herdr") spawnHerdr(ctx, options.specs, resolve, pruneNow);
  else if (ctx.mux === "cmux") spawnCmux(ctx, options.specs, resolve, pruneNow);
  else if (ctx.mux === "tmux") spawnTmux(ctx, options.specs, resolve);
  else spawnTerminal(ctx, options.specs, resolve);
}

function connect() {
  if (ctx.dry) return;
  call(process.execPath, [join(ctx.root, "bin/connect.mjs")], { env: ctx.env });
}

async function runUp(args, verify = true) {
  const options = parseUpArgs(args);
  const requested = resolveAgentLaunchSpecs(options.specs, readConfig());
  options.specs = requested.specs;
  if (options.persona && options.specs.length !== 1) throw new Error("--as requires exactly one agent");
  resultSeat = options.specs.map(spec => spec.split(":")[0]).join(",");
  if (!options.specs.length) {
    console.log("usage: crew.mjs up [--task K --difficulty D] codex glm kimi deepseek (or set a default in Settings → Agents)");
    return 1;
  }
  if (requested.disabled.length) {
    console.error(`[crew] ✗ ${requested.disabled.join(", ")} ${requested.disabled.length === 1 ? "is" : "are"} disabled in ~/.agent-bus/config.json — enable the seat in Settings → Agents`);
    return 1;
  }
  prune(ctx, adapters);
  connect();
  console.log(`[crew] hub for ${ctx.project}: ${ctx.hub} (baked into every seat; CREW_HUB=<url> overrides)`);
  console.log(`— bringing up crew for ${ctx.project} (${ctx.mux === "terminal" ? "Terminal windows" : ctx.mux}) —`);
  // #7760: build once in the first seat's worktree before any seat gets a contract.
  const skipped = [];
  const occupied = readRows(ctx).filter(row => row.project === ctx.project).map(row => row.persona);
  options.specs = options.specs.map(spec => {
    const resolved = resolveSpec(ctx, spec, options.task, options.difficulty, skipped);
    if (!resolved) return null;
    if (seatProcesses(ctx, ctx.project, resolved.agent).length && !occupied.includes(resolved.agent)) occupied.push(resolved.agent);
    const seat = allocatePersona({ dir: join(ctx.home, ".agent-bus"), project: ctx.project, ...resolved, name: options.persona, occupied, dry: ctx.dry });
    occupied.push(seat.persona);
    return { ...resolved, ...seat };
  }).filter(Boolean);
  resultSeat = options.specs.map(seat => seat.persona).join(",");
  if (!ctx.dry && options.specs.length) await preflightFirstSeat(ctx, options.specs[0].persona);
  const started = epochMs();
  spawnCrew(options, skipped);
  if (ctx.dry || !verify) {
    if (ctx.dry) console.log("— dry run: no bus verify —");
    return reportSkipped(skipped);
  }
  console.log("— verifying on the bus (the spawn is not the truth; the bus is) —");
  let failed = failedAgents(verifyCrew(ctx, options.specs.map(seat => seat.persona), started));
  if (failed.length) {
    const retry = options.specs.filter(seat => failed.includes(seat.persona));
    console.log(`— retrying failed spawns: ${retry.join(" ")} —`);
    options.specs = retry;
    spawnCrew(options, skipped);
    failed = failedAgents(verifyCrew(ctx, failed, epochMs()));
  }
  if (failed.length) {
    console.log(`\n✗✗ CREW INCOMPLETE — these agents are NOT on the bus: ${failed.join(",")}`);
    console.log(`   Do NOT assign them work. Investigate their panes/windows or run: crew.mjs up ${failed.join(" ")}`);
    return 1;
  }
  console.log("— crew verified on the bus. Send contracts with relay_send; runners keep agents alive for free. Teardown (this project only): trantor down —");
  return reportSkipped(skipped);
}

function spawnReplacement(context, seat) {
  const resolve = () => seat;
  const specs = [seat.agent];
  const noPrune = () => {};
  if (context.mux === "herdr") spawnHerdr(context, specs, resolve, noPrune);
  else if (context.mux === "cmux") spawnCmux(context, specs, resolve, noPrune);
  else if (context.mux === "tmux") spawnTmux(context, specs, resolve);
  else spawnTerminal(context, specs, resolve);
}

async function swap(args) {
  const options = swapOptions(args);
  resultSeat = options.from;
  if (resolveAgentLaunchSpecs([options.replacement], readConfig()).disabled.length) throw new Error(`replacement ${options.agent} is disabled in agent settings`);
  if (!guardCrossProjectUp(ctx)) throw new Error("cross-project swap refused");
  if (ctx.dry) throw new Error("swap requires a live bus; dry-run cannot verify a handoff");
  return performSwap(ctx, options, swapRuntime(ctx, adapters, spawnReplacement));
}

let code = 0;
let result;
try {
  if (command === "down") code = await down(ctx, rawArgs, adapters);
  else if (command === "prune") { prune(ctx, adapters); console.log(`— pruned dead crew rows (${ctx.statePath}) —`); }
  else if (command === "open") code = openOrchestrator(ctx, rawArgs);
  else if (command === "swap") { result = await swap(rawArgs); code = result.ok ? 0 : 1; }
  else if (command === "up") code = guardCrossProjectUp(ctx) ? await runUp(rawArgs) : 1;
  else { usage(); code = 1; }
} catch (error) {
  code = 1;
  result = jsonResult(code, { reason: redactKeys(error.message) });
}
if (!result) result = jsonResult(code);
if (!result.ok && !result.reason) result.reason = diagnostics.at(-1) || `${command} failed; see stderr`;
if (result.reason) result.reason = redactKeys(result.reason);
if (jsonMode) output(JSON.stringify(result));
else if (result.reason) console.error(result.reason);
else if (command === "swap") console.log(`— swapped ${result.seat} → ${result.to}; moved contracts: ${result.moved.join(", ") || "none"} —`);
process.exit(code);

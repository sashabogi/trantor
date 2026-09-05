#!/usr/bin/env node
import { join } from "node:path";
import { call, createContext } from "./crew/core.mjs";
import { createCmuxAdapter, spawnCmux } from "./crew/cmux.mjs";
import { createHerdrAdapter, spawnHerdr } from "./crew/herdr.mjs";
import { resolveSpec, reportSkipped } from "./crew/models.mjs";
import { openOrchestrator } from "./crew/open.mjs";
import { down, prune } from "./crew/state.mjs";
import { spawnTerminal, spawnTmux } from "./crew/tmux.mjs";
import { epochMs, failedAgents, verifyCrew } from "./crew/verify.mjs";
import { guardCrossProjectUp } from "./crew/worktrees.mjs";

const [command = "up", ...rawArgs] = process.argv.slice(2);
let ctx;
try { ctx = createContext(command); }
catch (error) { console.error(error.message); process.exit(1); }

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
    else result.specs.push(arg);
  }
  return result;
}

function spawnCrew(options, skipped) {
  const resolve = spec => resolveSpec(ctx, spec, options.task, options.difficulty, skipped);
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

function runUp(args, verify = true) {
  const options = parseUpArgs(args);
  if (!options.specs.length) {
    console.log("usage: crew.mjs up [--task K --difficulty D] codex glm kimi deepseek (agent:provider picks a live model; agent:provider/model pins one)");
    return 1;
  }
  prune(ctx, adapters);
  connect();
  console.log(`[crew] hub for ${ctx.project}: ${ctx.hub} (baked into every seat; CREW_HUB=<url> overrides)`);
  console.log(`— bringing up crew for ${ctx.project} (${ctx.mux === "terminal" ? "Terminal windows" : ctx.mux}) —`);
  const skipped = [];
  const started = epochMs();
  spawnCrew(options, skipped);
  if (ctx.dry || !verify) {
    if (ctx.dry) console.log("— dry run: no bus verify —");
    return reportSkipped(skipped);
  }
  console.log("— verifying on the bus (the spawn is not the truth; the bus is) —");
  let failed = failedAgents(verifyCrew(ctx, options.specs.map(spec => spec.split(":")[0]), started));
  if (failed.length) {
    const retry = options.specs.filter(spec => failed.includes(spec.split(":")[0]));
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

function swap(args) {
  const [oldAgent, replacement, ...flags] = args;
  if (!oldAgent || !replacement) {
    console.log("usage: trantor swap <oldAgent> <newAgent[:provider[/model]]> [--task K --difficulty D]");
    return 1;
  }
  console.log(`— tearing down old seat '${oldAgent}' in ${ctx.project} —`);
  down(ctx, [oldAgent], adapters);
  console.log(`— spawning replacement: ${replacement} —`);
  const code = runUp([...flags, replacement]);
  if (!code) console.log(`— swapped. RESEND the contract to '${replacement.split(":")[0]}' (it joined fresh with no context). —`);
  return code;
}

let code = 0;
if (command === "down") code = down(ctx, rawArgs, adapters);
else if (command === "prune") { prune(ctx, adapters); console.log(`— pruned dead crew rows (${ctx.statePath}) —`); }
else if (command === "open") code = openOrchestrator(ctx, rawArgs);
else if (command === "swap") code = swap(rawArgs);
else if (command === "up") code = guardCrossProjectUp(ctx) ? runUp(rawArgs) : 1;
else { usage(); code = 1; }
process.exit(code);

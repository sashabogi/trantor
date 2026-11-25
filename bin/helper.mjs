#!/usr/bin/env node
// #14264: helpers share the crew pane registry so the desktop can attach to their live output.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { commandExists, formatCommand } from "./crew/core.mjs";
import { closePane, createWorkspace, herdrCall, paneAlive, reportAgent, splitPane, workspaceList, workspacePane } from "./crew/herdr.mjs";
import { dropState, readRows, recordState } from "./crew/state.mjs";
import { herdrReportArgs } from "../lib/herdr-integration.mjs";

const USAGE = "usage: trantor helper run --project <name> --label <label> [--cwd <dir>] -- <command...> | list --project <name> | stop <pane>";

function parse(args) {
  const [action, ...rest] = args;
  const options = { action, project: "", label: "", cwd: process.cwd(), command: [], pane: "", json: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--" && action === "run") { options.command = rest.slice(i + 1); break; }
    if (arg === "--json") { options.json = true; continue; }
    if (["--project", "--label", "--cwd"].includes(arg) && rest[i + 1] && !rest[i + 1].startsWith("--")) {
      options[arg.slice(2)] = rest[++i];
    } else if (action === "stop" && !options.pane && !arg.startsWith("-")) options.pane = arg;
    else throw new Error(USAGE);
  }
  if (!["run", "list", "stop"].includes(action)
    || (action !== "stop" && !options.project.trim())
    || (action === "run" && (!options.label.trim() || !options.command.length))
    || (action === "stop" && !options.pane)) throw new Error(USAGE);
  for (const value of [options.project, options.label, options.pane]) {
    if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("Project, label and pane must be single-line text");
  }
  return options;
}

export function helperCommand(pane, command, env) {
  const done = formatCommand("herdr", herdrReportArgs({ pane, agent: "helper", state: "idle" }));
  const script = `"$@"; helper_exit=$?; ${done} >/dev/null 2>&1; printf '\\nhelper finished, exit %s\\n' "$helper_exit"; while :; do sleep 86400; done`;
  const vars = [`PATH=${env.PATH || ""}`];
  if (env.HERDR_SOCKET_PATH) vars.push(`HERDR_SOCKET_PATH=${env.HERDR_SOCKET_PATH}`);
  return formatCommand("env", [...vars, "/bin/sh", "-c", script, "helper", ...command]);
}

function projectPane(ctx) {
  const tracked = readRows(ctx).filter(row => row.project === ctx.project);
  const workspaces = [...new Set([
    ...tracked.filter(row => row.kind === "herdrws").map(row => row.handle).reverse(),
    ...workspaceList(ctx).items.filter(w => [w.label, w.name, w.custom_title].includes(`trantor:${ctx.project}`)).map(w => w.workspace_id || w.id),
  ].filter(Boolean))];
  for (const workspace of workspaces) {
    const pane = workspacePane(ctx, workspace, ctx.dir);
    if (!pane) continue;
    recordState(ctx, ctx.project, "herdrws", "__ws__", workspace);
    return pane;
  }
  // #14264: an orchestrator can be tracked before a workspace row is recorded.
  for (const row of tracked.filter(r => ["orch", "herdr", "helper"].includes(r.kind)).reverse()) {
    if (paneAlive(ctx, row.handle)) return row.handle;
  }
  const created = createWorkspace(ctx, ctx.dir, `trantor:${ctx.project}`);
  recordState(ctx, ctx.project, "herdrws", "__ws__", created.workspace);
  return created.pane;
}

function requireCall(ctx, args) {
  const r = herdrCall(ctx, args);
  if (!r.ok) throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed: ${r.stderr || r.stdout || r.status}`);
}

export function main(args = process.argv.slice(2), env = process.env) {
  const opts = parse(args);
  const ctx = {
    env, project: opts.project, dir: resolve(opts.cwd), dry: false,
    statePath: join(env.AGENT_BUS_DIR || join(env.HOME || homedir(), ".agent-bus"), "crew-windows.txt"),
    have: { herdr: commandExists("herdr", env) },
  };
  if (!ctx.have.herdr) {
    console.error("Helpers need herdr to show in the app. Running commands in this terminal.");
    if (opts.action !== "run") return opts.action === "list" ? 0 : 1;
    const result = spawnSync(opts.command[0], opts.command.slice(1), { cwd: ctx.dir, env, stdio: "inherit" });
    if (result.error) console.error(result.error.message);
    return result.status ?? 1;
  }
  mkdirSync(dirname(ctx.statePath), { recursive: true });
  if (opts.action === "list") {
    for (const row of readRows(ctx).filter(r => r.project === opts.project && r.kind === "helper")) {
      if (paneAlive(ctx, row.handle)) console.log(`${row.handle}\t${row.persona}`);
      else dropState(ctx, row.project, "helper", "", row.handle);
    }
    return 0;
  }
  if (opts.action === "stop") {
    const rows = readRows(ctx).filter(r => r.kind === "helper" && r.handle === opts.pane);
    if (!rows.length) throw new Error(`No tracked helper at ${opts.pane}`);
    if (!closePane(ctx, opts.pane) && paneAlive(ctx, opts.pane)) throw new Error(`Could not stop helper ${opts.pane}`);
    for (const row of rows) dropState(ctx, row.project, "helper", "", row.handle);
    if (opts.json) console.log(JSON.stringify({ ok: true }));
    return 0;
  }
  const pane = splitPane(ctx, projectPane(ctx), "right", ctx.dir);
  if (!pane) throw new Error("herdr returned no helper pane");
  try {
    requireCall(ctx, ["pane", "rename", pane, opts.label]);
    reportAgent(ctx, pane, "helper");
    recordState(ctx, ctx.project, "helper", opts.label, pane, { agent: "helper" });
    requireCall(ctx, ["pane", "run", pane, helperCommand(pane, opts.command, env)]);
  } catch (error) {
    if (closePane(ctx, pane)) dropState(ctx, ctx.project, "helper", "", pane);
    throw error;
  }
  console.log(pane);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) { console.error(`trantor helper: ${error.message}`); process.exitCode = 1; }
}

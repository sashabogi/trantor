import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { call, listPids, run } from "./core.mjs";

export function parseRow(line) {
  const fields = line.split("\t");
  if (fields.length >= 4) return { project: fields[0], kind: fields[1], agent: fields[2], handle: fields[3] };
  if (fields.length === 2) return { project: "", kind: "win", agent: fields[0], handle: fields[1] };
  return { project: "", kind: "win", agent: fields[0] || "", handle: fields[1] || "" };
}

export function readRows(ctx) {
  if (!existsSync(ctx.statePath)) return [];
  return readFileSync(ctx.statePath, "utf8").split("\n").filter(Boolean).map(parseRow);
}

export function writeRows(ctx, rows) {
  if (ctx.dry) return;
  if (!rows.length) {
    try { unlinkSync(ctx.statePath); } catch {}
    return;
  }
  const tmp = `${ctx.statePath}.tmp`;
  writeFileSync(tmp, `${rows.map(row => [row.project, row.kind, row.agent, row.handle].join("\t")).join("\n")}\n`);
  renameSync(tmp, ctx.statePath);
}

export function recordState(ctx, project, kind, agent, handle) {
  if (ctx.dry) return;
  const rows = readRows(ctx);
  rows.push({ project, kind, agent, handle });
  writeRows(ctx, rows);
}

export function dropState(ctx, project, kind, agent = "", handle = "") {
  const rows = readRows(ctx).filter(row => !(
    row.project === project && row.kind === kind &&
    (!agent || row.agent === agent) && (!handle || row.handle === handle)
  ));
  writeRows(ctx, rows);
}

function killSeatProcesses(ctx, project, agent) {
  if (ctx.env.CREW_NO_PROC_KILL === "1" || !project || !agent) return;
  const patterns = [`seats/${project}-${agent}\\.sh`, `crew-runner\\.mjs ${agent} .*/${project}$`];
  for (const pattern of patterns) {
    for (const pid of listPids(pattern)) run(ctx, "kill", ["-9", pid], { rendered: `kill -9 ${pid} 2>/dev/null` });
  }
}

function killTerminal(ctx, handle) {
  if (!handle) return;
  const tty = call("osascript", ["-e", `tell application \"Terminal\" to get tty of (first window whose id is ${handle})`]).stdout;
  if (tty) {
    const processes = call("ps", ["-t", tty.replace("/dev/", ""), "-o", "pid="]).stdout.split(/\s+/).filter(Boolean);
    for (const pid of processes) run(ctx, "kill", ["-9", pid], { rendered: `kill -9 ${pid} 2>/dev/null` });
  }
  run(ctx, "osascript", ["-e", `tell application \"Terminal\" to close (first window whose id is ${handle})`]);
}

function usage(project) {
  console.log(`usage: trantor down [<agent>...] [--all] [--yes]\n  trantor down              tear down THIS project's crew (${project})\n  trantor down codex glm    tear down only those seats in this project\n  trantor down --all --yes  tear down EVERY project's crew on this machine (--yes required)`);
}

function parseDownArgs(ctx, args) {
  const parsed = { all: false, yes: false, agents: [] };
  for (const arg of args) {
    if (arg === "--all") parsed.all = true;
    else if (arg === "--yes" || arg === "-y") parsed.yes = true;
    else if (arg === "--help" || arg === "-h") { usage(ctx.project); return { help: true }; }
    else if (arg.startsWith("--")) {
      console.log(`trantor down: unknown flag '${arg}'`);
      usage(ctx.project);
      return { error: true };
    } else parsed.agents.push(arg);
  }
  return parsed;
}

function closeRow(ctx, row, selected, orchProjects, adapters, tmuxClosed) {
  const perSeat = selected.length > 0;
  const hasOrch = orchProjects.has(row.project);
  if (row.kind === "cmuxws" && !perSeat && !hasOrch) adapters.cmux.closeWorkspace(row.handle);
  if (row.kind === "cmux" && (perSeat || hasOrch)) adapters.cmux.closePane(row.handle);
  if (row.kind === "herdrws" && !perSeat && !hasOrch) adapters.herdr.closeWorkspace(row.handle);
  if (row.kind === "herdr" && (perSeat || hasOrch)) adapters.herdr.closePane(row.handle);
  if (row.kind === "tmux") closeTmux(ctx, row, perSeat, tmuxClosed);
  if ((row.kind === "win" || row.kind === "attach") && !(perSeat && row.kind === "attach")) killTerminal(ctx, row.handle);
  if (!["cmuxws", "attach", "herdrws", "orch"].includes(row.kind)) killSeatProcesses(ctx, row.project, row.agent);
}

function closeTmux(ctx, row, perSeat, seen) {
  if (perSeat) {
    run(ctx, "tmux", ["kill-pane", "-t", row.handle], { rendered: `tmux kill-pane -t '${row.handle}' 2>/dev/null` });
    return;
  }
  const session = `trantor:${row.project}`;
  if (seen.has(session)) return;
  seen.add(session);
  run(ctx, "tmux", ["kill-session", "-t", session], { rendered: `tmux kill-session -t '${session}' 2>/dev/null` });
}

export function down(ctx, args, adapters) {
  const options = parseDownArgs(ctx, args);
  if (options.help) return 0;
  if (options.error) return 1;
  const rows = readRows(ctx);
  if (!rows.length) { console.log("no tracked crew windows"); return 0; }
  const scoped = rows.filter(row => (options.all || row.project === ctx.project) && (!options.agents.length || options.agents.includes(row.agent)));
  const scope = options.all ? "all projects" : `project \"${ctx.project}\"`;
  if (!scoped.length) { console.log(`nothing to tear down for ${scope}`); return 0; }
  console.log(`— tearing down (${scope}):`);
  for (const row of scoped) if (!["attach", "cmuxws", "herdrws", "orch"].includes(row.kind)) console.log(`  • ${row.project || "<legacy>"} · ${row.agent} (${row.kind})`);
  if (options.all && !options.yes) {
    console.log("— this is EVERY project's crew. Re-run with --yes to confirm:  trantor down --all --yes");
    return 0;
  }
  const orchProjects = new Set(rows.filter(row => row.kind === "orch").map(row => row.project));
  const tmuxClosed = new Set();
  for (const row of scoped) closeRow(ctx, row, options.agents, orchProjects, adapters, tmuxClosed);
  const removed = new Set(scoped.map(row => `${row.project}|${row.kind}|${row.agent}|${row.handle}`));
  const kept = rows.filter(row => !removed.has(`${row.project}|${row.kind}|${row.agent}|${row.handle}`) || (orchProjects.has(row.project) && ["herdrws", "cmuxws", "orch"].includes(row.kind)));
  writeRows(ctx, kept);
  console.log(`— crew torn down (${scope})`);
  return 0;
}

function terminalAlive(row) {
  return Boolean(call("osascript", ["-e", `tell application \"Terminal\" to get id of (first window whose id is ${row.handle})`]).stdout);
}

export function prune(ctx, adapters) {
  const rows = readRows(ctx);
  if (!rows.length || ctx.dry) return;
  const cmuxLive = adapters.cmux.liveWorkspaces();
  const herdrLive = adapters.herdr.liveWorkspaces();
  const kept = rows.filter(row => {
    if (["win", "attach"].includes(row.kind)) return terminalAlive(row);
    if (row.kind === "tmux") return call("tmux", ["has-session", "-t", `trantor:${row.project}`]).ok;
    if (row.kind === "cmuxws") return !cmuxLive.proven || cmuxLive.ids.has(row.handle);
    if (row.kind === "cmux") return !cmuxLive.proven || cmuxLive.names.has(`trantor:${row.project}`);
    if (row.kind === "herdrws") return !herdrLive.proven || herdrLive.ids.has(row.handle);
    if (["herdr", "orch"].includes(row.kind)) return !herdrLive.proven || herdrLive.names.has(`trantor:${row.project}`);
    return true;
  });
  writeRows(ctx, kept);
}

export function reapSeat(ctx, agent) {
  const escapedDir = ctx.dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const pid of listPids(`crew-runner\\.mjs ${agent} ${escapedDir}$`)) {
    run(ctx, "kill", ["-9", pid], { rendered: `kill -9 ${pid} 2>/dev/null` });
  }
}

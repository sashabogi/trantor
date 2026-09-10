import { randomUUID } from "node:crypto";
import { existsSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn, execSync } from "node:child_process";
import { call, parseJsonOutput } from "./core.mjs";
import { createWorkspace, herdrCall, paneAlive, reportAgent, splitPane, workspaceList, workspacePane } from "./herdr.mjs";
import { dropState, readRows, recordState } from "./state.mjs";
import { resolveOrchestratorDir } from "./worktrees.mjs";

const STRIP = [
  "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_BRIDGE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH", "CLAUDE_PID",
];

function usage() {
  console.log("usage: trantor open [<project>]\n  host THIS project's orchestrator session as a herdr pane in workspace trantor:<project>\n  (creating the workspace if needed) and print its TARGET on stdout. A second open REATTACHES:\n  it prints the existing target and exits 0 without spawning a second orchestrator.");
}

function parseArgs(args) {
  let project = "";
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg.startsWith("--")) throw new Error(`trantor open: unknown flag '${arg}'`);
    project = arg;
  }
  return { project };
}

function sessionFile(ctx) {
  return join(ctx.home, ".agent-bus", "orch-sessions.txt");
}

function sessionId(ctx) {
  const file = sessionFile(ctx);
  if (existsSync(file)) {
    const row = readFileSync(file, "utf8").split("\n").map(line => line.split("\t")).find(([project, id]) => project === ctx.project && id);
    if (row) return row[1];
  }
  const id = randomUUID();
  if (!ctx.dry) writeFileSync(file, `${existsSync(file) ? readFileSync(file, "utf8") : ""}${ctx.project}\t${id}\n`);
  return id;
}

export function hasPendingHandoff(ctx) {
  const dir = join(ctx.env.AGENT_BUS_DIR || ctx.env.RELAY_DATA_DIR || join(ctx.home, ".agent-bus"), "handoffs");
  if (!existsSync(dir)) return false;
  const prefix = `${ctx.project}-`;
  for (const file of readdirSync(dir).filter(name => name.startsWith(prefix) && name.endsWith(".json")).sort().reverse()) {
    try { if (!JSON.parse(readFileSync(join(dir, file), "utf8")).consumed) return true; }
    catch {}
  }
  return false;
}

export function takeoverSessionId(ctx, id) {
  return hasPendingHandoff(ctx) ? randomUUID() : id;
}

function harnessFlag(ctx) {
  const result = call(process.execPath, [join(ctx.root, "bin/autonomy.mjs"), "get", "harness", "--project", ctx.project], { env: ctx.env });
  return result.stdout === "bypass" ? " --dangerously-skip-permissions" : "";
}

function transcript(ctx, id) {
  const slug = ctx.dir.replace(/[/.]/g, "-");
  return join(ctx.home, ".claude", "projects", slug, `${id}.jsonl`);
}

function orchestratorCommand(ctx, id) {
  const env = `env ${STRIP.map(name => `-u ${name}`).join(" ")} TRANTOR_ORCH=${ctx.project}`;
  const action = existsSync(transcript(ctx, id)) ? `--resume ${id}` : `--session-id ${id}`;
  return `${env} claude${harnessFlag(ctx)} ${action}`;
}

export function paneHasAgent(ctx, pane) {
  const result = herdrCall(ctx, ["pane", "process-info", "--pane", pane]);
  const info = parseJsonOutput(result.stdout)?.result?.process_info;
  if (!result.ok || !info) return false;
  const processes = Array.isArray(info.foreground_processes) ? info.foreground_processes : [];
  return processes.some(process => {
    const command = [process.name, process.argv0, process.cmdline, ...(Array.isArray(process.argv) ? process.argv : [])]
      .filter(Boolean)
      .join(" ");
    return /(^|[/\s])claude(?:\.exe)?(?:$|\s)/i.test(command);
  });
}

function tracked(ctx, live) {
  let workspace = "";
  let pane = "";
  for (const row of readRows(ctx).filter(row => row.project === ctx.project)) {
    if (row.kind === "herdrws") {
      if (!ctx.dry && live.proven && !live.ids.has(row.handle)) dropState(ctx, ctx.project, "herdrws", "", row.handle);
      else workspace = row.handle;
    }
    if (row.kind === "orch") pane = row.handle;
  }
  return { workspace, pane };
}

function reattach(ctx, workspace, pane, id) {
  if (!pane) return false;
  if (ctx.dry) { console.log(`herdr:${workspace || "%DRYWS"}/${pane}`); return true; }
  // Two probes, because herdr answers them from different places: a pane a restart left in the
  // layout without a terminal still answers rename, and only process-info says it cannot host
  // anything. Either way the row is dead and the open path hosts a fresh pane.
  if (!paneAlive(ctx, pane)) {
    dropState(ctx, ctx.project, "orch");
    console.error(`— tracked orchestrator pane ${pane} has no terminal behind it (herdr restarted without it): hosting a fresh pane —`);
    return false;
  }
  const renamed = herdrCall(ctx, ["pane", "rename", pane, `orchestrator · ${ctx.project}`]);
  if (!renamed.ok) { dropState(ctx, ctx.project, "orch"); return false; }
  if (!paneHasAgent(ctx, pane)) {
    const started = herdrCall(ctx, ["pane", "run", pane, orchestratorCommand(ctx, id)]);
    if (!started.ok) throw new Error(`trantor open: could not start the orchestrator in pane ${pane}`);
    reportAgent(ctx, pane, "claude");
    console.error(`— orchestrator pane was empty: resumed session ${id} in herdr:${workspace || "?"}/${pane} —`);
  } else console.error(`— orchestrator already hosted: reattached to herdr:${workspace || "?"}/${pane} —`);
  console.log(`herdr:${workspace || "?"}/${pane}`);
  return true;
}

function chooseWorkspace(ctx, live, existing) {
  if (existing) return { workspace: existing, pane: "", fresh: false };
  if (ctx.dry) {
    console.error(`[dry] herdr: workspace create (cwd ${ctx.dir}) --label 'trantor:${ctx.project}'`);
    return { workspace: "%DRYWS", pane: "", fresh: false };
  }
  const found = live.items.find(item => [item.label, item.name, item.custom_title].includes(`trantor:${ctx.project}`));
  if (found) {
    const workspace = found.workspace_id || found.id || "";
    console.error(`— adopting existing crew workspace for ${ctx.project} (${workspace}) —`);
    return { workspace, pane: "", fresh: false };
  }
  const created = createWorkspace(ctx, ctx.dir, `trantor:${ctx.project}`);
  if (!created.workspace) throw new Error("trantor open: herdr workspace create failed");
  return { workspace: created.workspace, pane: created.pane, fresh: true };
}

function hostPane(ctx, chosen, id) {
  let pane = chosen.pane;
  if (ctx.dry) {
    pane = "%DRYORCH";
    if (!chosen.fresh) console.error(`[dry] herdr: pane split %DRYHOST(${chosen.workspace}) --direction right --cwd ${ctx.dir}`);
    console.error(`[dry] herdr: pane rename ${pane} 'orchestrator · ${ctx.project}' + run '${orchestratorCommand(ctx, id)}'`);
    return pane;
  }
  if (!chosen.fresh) {
    const host = workspacePane(ctx, chosen.workspace, ctx.dir);
    if (!host) throw new Error(`trantor open: workspace ${chosen.workspace} has no live pane to host the orchestrator`);
    pane = splitPane(ctx, host, "right", ctx.dir);
  }
  if (!pane) throw new Error("trantor open: could not create the orchestrator pane");
  herdrCall(ctx, ["pane", "rename", pane, `orchestrator · ${ctx.project}`]);
  herdrCall(ctx, ["pane", "run", pane, orchestratorCommand(ctx, id)]);
  reportAgent(ctx, pane, "claude");
  return pane;
}

// #6888: index the project once so its seats' Graft tools (graft_find_code, _trace_calls, …) have a
// graph to serve. Non-blocking — the pane opens now, the ~7s build lands in the background; a no-op
// if graft isn't installed or the index already exists (the graph self-refreshes per query after the
// first build). Keeps the 20MB index out of the project's git.
export function maybeBuildGraft(dir) {
  if (!dir) return;
  try { execSync("command -v graft", { stdio: "ignore", shell: "/bin/sh" }); } catch { return; }
  try {
    if (existsSync(join(dir, "graft", ".graph"))) return;
    const gi = join(dir, ".gitignore");
    try {
      const cur = existsSync(gi) ? readFileSync(gi, "utf8") : "";
      if (!/^graft\/?$/m.test(cur)) writeFileSync(gi, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + "graft/\n");
    } catch {}
    // The build is backgrounded, so its exit code cannot gate the pane, but a failure has to land
    // SOMEWHERE: under stdio:"ignore" a graft without native parsers (see deploy/setup.sh) failed in
    // silence while the line below still claimed an index was being built.

    // The log goes to the OS temp dir rather than the project: nothing to gitignore, nothing to clean
    // up, and no exit handler — after unref() the parent usually dies first, so an on-exit cleanup
    // would be a promise we cannot keep. It is simply overwritten by the next open of this project.
    const log = join(tmpdir(), `trantor-graft-build-${basename(dir)}.log`);
    let fd = "ignore";
    try { fd = openSync(log, "w"); } catch {}
    const child = spawn("graft", ["build", dir], { cwd: dir, stdio: ["ignore", fd, fd], detached: true });
    child.on("error", () => {});   // ENOENT/EACCES: the log and the absent index are the evidence
    child.unref();
    console.error(`— indexing this project for the seats' Graft tools in the background (failures land in ${log}) —`);
  } catch {}
}

export function openOrchestrator(ctx, args) {
  let parsed;
  try { parsed = parseArgs(args); }
  catch (error) { console.error(error.message); usage(); return 1; }
  if (parsed.help) { usage(); return 0; }
  try {
    Object.assign(ctx, resolveOrchestratorDir(ctx, parsed.project));
    if (!ctx.dry) maybeBuildGraft(ctx.dir);
    if (!ctx.have.herdr) throw new Error("trantor open needs herdr (the pane host) — install: curl -fsSL https://herdr.dev/install.sh | sh");
    let id = sessionId(ctx);
    if (hasPendingHandoff(ctx)) {
      const fresh = takeoverSessionId(ctx, id);
      console.error(`— recorded session ${id} handed off: starting fresh as ${fresh} to claim it —`);
      id = fresh;
    }
    const live = ctx.dry ? { proven: false, ids: new Set(), names: new Set(), items: [] } : workspaceList(ctx);
    const prior = tracked(ctx, live);
    if (reattach(ctx, prior.workspace, prior.pane, id)) return 0;
    const chosen = chooseWorkspace(ctx, live, prior.workspace);
    recordState(ctx, ctx.project, "herdrws", "__ws__", chosen.workspace);
    const pane = hostPane(ctx, chosen, id);
    dropState(ctx, ctx.project, "orch");
    recordState(ctx, ctx.project, "orch", "__orch__", pane);
    console.log(`herdr:${chosen.workspace}/${pane}`);
    console.error(`— orchestrator pane hosted: herdr:${chosen.workspace}/${pane} (claude in ${ctx.dir}). 'trantor down' spares it. —`);
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

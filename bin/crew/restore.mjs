import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { call, parseJsonOutput } from "./core.mjs";
import { paneAlive, paneHasAgent, herdrCall } from "./herdr.mjs";
import { readRows } from "./state.mjs";

function config(ctx) {
  try { return JSON.parse(readFileSync(join(ctx.home, ".agent-bus", "config.json"), "utf8")); }
  catch { return {}; }
}

function sessionIds(ctx, rows, agents) {
  const result = new Map();
  const file = join(ctx.home, ".agent-bus", "orch-sessions.txt");
  if (!existsSync(file)) return result;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const [project, id] = line.split("\t");
    if (project && id) result.set(project, id);
  }
  const paneProject = new Map(rows.filter(row => row.kind === "orch").map(row => [row.handle, row.project]));
  for (const agent of agents) {
    const project = paneProject.get(agent.pane_id);
    const nativeId = agent.agent_session?.value;
    if (project && nativeId) result.set(project, nativeId);
  }
  return result;
}

export function restoreCandidates({ rows, configured, frozen = [], dismissed = [], sessions = new Map(), live = new Set() }) {
  const projects = [...new Set(rows.filter(row => row.kind === "orch").map(row => row.project))];
  return projects.filter(project => configured.includes(project)
    && !frozen.includes(project)
    && !live.has(project)
    && !dismissed.some(item => item.project === project && item.sessionId === sessions.get(project)));
}

function dismissedSessions(ctx) {
  try {
    const value = JSON.parse(readFileSync(join(ctx.home, ".agent-bus", "config.json"), "utf8"));
    return Array.isArray(value.dismissedSessions) ? value.dismissedSessions : [];
  } catch { return []; }
}

export async function restoreOrchestrators(ctx, args = []) {
  if (args[0] === "enable" || args[0] === "disable") {
    const [action, project, extra] = args;
    if (!project || extra) throw new Error("usage: trantor restore enable|disable <project>");
    const cfg = config(ctx);
    const set = new Set(Array.isArray(cfg.resumeOnRestore) ? cfg.resumeOnRestore : []);
    if (action === "enable") set.add(project); else set.delete(project);
    cfg.resumeOnRestore = [...set].sort();
    const file = join(ctx.home, ".agent-bus", "config.json");
    mkdirSync(join(ctx.home, ".agent-bus"), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
    renameSync(tmp, file);
    console.log(`${project} ${action}d for Trantor restore`);
    return 0;
  }
  const unknown = args.filter(arg => arg !== "--dry-run");
  if (unknown.length) throw new Error("usage: trantor restore [--dry-run]");
  if (args.includes("--dry-run")) ctx.dry = true;
  if (!ctx.have.herdr) throw new Error("trantor restore needs herdr");
  const cfg = config(ctx);
  const configured = Array.isArray(cfg.resumeOnRestore) ? cfg.resumeOnRestore : [];
  const frozen = Array.isArray(cfg.frozenProjects) ? cfg.frozenProjects : [];
  const rows = readRows(ctx);
  const parsed = parseJsonOutput(herdrCall(ctx, ["agent", "list"]).stdout);
  const agents = parsed?.result?.agents || parsed?.agents || [];
  const sessions = sessionIds(ctx, rows, agents);
  const livePanes = new Set(agents.map(agent => agent.pane_id).filter(Boolean));
  const live = new Set(rows.filter(row => row.kind === "orch" && livePanes.has(row.handle) && paneAlive(ctx, row.handle) && paneHasAgent(ctx, row.handle)).map(row => row.project));
  const selected = restoreCandidates({ rows, configured, frozen, dismissed: dismissedSessions(ctx), sessions, live });
  if (!selected.length) {
    console.log("no configured interrupted orchestrators to restore (use trantor restore enable <project>)");
    return 0;
  }
  for (const project of selected) {
    if (ctx.dry) console.log(`would restore ${project}`);
    else {
      const result = call(process.execPath, [join(ctx.root, "bin/crew.mjs"), "open", project], { env: ctx.env });
      if (!result.ok) throw new Error(`trantor restore: ${project} failed: ${result.stderr || result.stdout}`);
      console.log(`restored ${project}`);
    }
    if (!ctx.dry) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return 0;
}

#!/usr/bin/env node
// trantor patrol — machine-wide crew/resource report. It never kills live processes.
import { readdirSync, rmSync, statSync } from "node:fs";
import { join, basename, dirname, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DAY = 24 * 60 * 60 * 1000;

const emptyResources = {
  inventory: () => ({ rows: [], runners: [], workspaces: [], devServers: [] }),
  cleanDead: () => "",
};

function busDir(env = process.env) {
  if (env.AGENT_BUS_DIR) return env.AGENT_BUS_DIR;
  return join(env.RELAY_DATA_DIR || homedir(), ".agent-bus");
}

function isUnderDir(path, parent) {
  if (!path || !parent) return false;
  const child = resolve(String(path));
  const root = resolve(String(parent));
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}

function isBusInternalRunner(runner, bus) {
  return isUnderDir(runner?.dir, bus);
}

function safeArray(v) { return Array.isArray(v) ? v : []; }
function displayProject(p) { return p || "<legacy>"; }
function runnerProject(r) { return String(r?.project || (r?.dir ? basename(String(r.dir)) : "") || ""); }
function workspaceProject(w) {
  const m = /^trantor:([^/]+)$/.exec(String(w?.title || ""));
  return m ? m[1] : "";
}
function rowProject(row) { return String(row?.project || ""); }
function rowMatchesRunner(row, runner) {
  if (String(row?.agent || "") !== String(runner?.agent || "")) return false;
  const rp = rowProject(row);
  return !rp || rp === runnerProject(runner);
}

function seatProvider(agent) {
  if (["codex", "kimi", "claude", "gemini", "dsh", "opencode"].includes(agent)) return null;
  return agent === "glm" ? "zai-coding-plan" : agent;
}

function sortedProjects(projects) {
  return [...projects].sort((a, b) => displayProject(a).localeCompare(displayProject(b)));
}

export function buildPatrolReport(rawInventory = {}, reaped = [], { bus = busDir() } = {}) {
  const rows = safeArray(rawInventory.rows);
  const runners = safeArray(rawInventory.runners);
  const workspaces = safeArray(rawInventory.workspaces);
  const devServers = safeArray(rawInventory.devServers);
  const projects = new Set();
  for (const row of rows) projects.add(rowProject(row));
  for (const runner of runners) projects.add(runnerProject(runner));
  for (const ws of workspaces) {
    const p = workspaceProject(ws);
    if (p) projects.add(p);
  }
  for (const dev of devServers) if (dev?.project) projects.add(String(dev.project));

  const out = {};
  for (const p of sortedProjects(projects)) out[p] = { rows: [], runners: [], workspaces: [], devServers: [] };
  const ensure = (p) => (out[p] ||= { rows: [], runners: [], workspaces: [], devServers: [] });

  for (const row of rows) ensure(rowProject(row)).rows.push(row);
  for (const runner of runners) ensure(runnerProject(runner)).runners.push(runner);
  for (const ws of workspaces) {
    const p = workspaceProject(ws);
    if (p) ensure(p).workspaces.push(ws);
  }
  for (const dev of devServers) if (dev?.project) ensure(String(dev.project)).devServers.push(dev);

  const workspaceIds = new Set(workspaces.map(w => String(w?.id || "")).filter(Boolean));
  const orphans = [];
  const ambiguous = [];
  const warnings = [];

  for (const runner of runners) {
    if (isBusInternalRunner(runner, bus)) continue;
    const p = runnerProject(runner);
    if (!p) {
      ambiguous.push({ type: "runner-without-project", pid: runner.pid, agent: runner.agent, dir: runner.dir });
    } else if (!rows.some(row => rowMatchesRunner(row, runner))) {
      orphans.push({ type: "live-runner-without-row", project: p, agent: runner.agent, pid: runner.pid, dir: runner.dir });
    }
    const expectedProvider = seatProvider(String(runner?.agent || ""));
    const actualProvider = String(runner?.model || "").split("/")[0];
    if (expectedProvider && actualProvider && actualProvider !== expectedProvider) {
      warnings.push({
        type: "seat-model-provider-mismatch",
        project: p,
        agent: runner.agent,
        model: runner.model,
        expectedProvider,
        pid: runner.pid,
      });
    }
  }

  for (const ws of workspaces) {
    const p = workspaceProject(ws);
    if (!p) {
      ambiguous.push({ type: "non-trantor-workspace", id: ws.id, title: ws.title });
    } else if (!runners.some(r => runnerProject(r) === p)) {
      orphans.push({ type: "workspace-without-live-runner", project: p, id: ws.id, title: ws.title });
    }
  }

  for (const row of rows) {
    const p = rowProject(row);
    const kind = String(row?.kind || "");
    let live = runners.some(runner => rowMatchesRunner(row, runner));
    if (kind === "cmuxws") live = workspaceIds.has(String(row?.handle || ""));
    if (!live) {
      orphans.push({
        type: "dead-tracking-row",
        project: p,
        kind: row.kind,
        agent: row.agent,
        handle: row.handle,
      });
    } else if (!p) {
      ambiguous.push({ type: "legacy-tracking-row", kind: row.kind, agent: row.agent, handle: row.handle });
    }
  }

  for (const p of Object.keys(out)) {
    const project = out[p];
    project.counts = {
      rows: project.rows.length,
      runners: project.runners.length,
      workspaces: project.workspaces.length,
      devServers: project.devServers.length,
    };
  }

  return { projects: out, orphans, ambiguous, warnings, reaped };
}

function oldEnough(path, now, maxAgeMs) {
  try { return now - statSync(path).mtimeMs > maxAgeMs; } catch { return false; }
}

function liveSeatFiles(runners) {
  const keys = new Set();
  for (const r of safeArray(runners)) {
    const p = runnerProject(r);
    const agent = String(r?.agent || "");
    if (p && agent) keys.add(`${p}-${agent}.sh`);
  }
  return keys;
}

export function reapStaleArtifacts({ bus = busDir(), runners = [], now = Date.now(), remove = rmSync } = {}) {
  const reaped = [];
  const seats = join(bus, "seats");
  const liveSeats = liveSeatFiles(runners);
  try {
    for (const name of readdirSync(seats)) {
      if (!name.endsWith(".sh")) continue;
      const path = join(seats, name);
      if (liveSeats.has(name) || !oldEnough(path, now, 14 * DAY)) continue;
      remove(path, { force: true });
      reaped.push({ type: "seat-script", path, reason: "no matching live runner and mtime >14d" });
    }
  } catch {}

  try {
    for (const name of readdirSync(bus)) {
      const startup = /^kimi-startup-.*\.txt\.consumed$/.test(name) || /^startup-.*\.txt\.consumed$/.test(name);
      if (!startup) continue;
      const path = join(bus, name);
      if (!oldEnough(path, now, 7 * DAY)) continue;
      remove(path, { force: true });
      reaped.push({ type: "startup-stash", path, reason: "consumed startup stash mtime >7d" });
    }
  } catch {}
  return reaped;
}

export async function loadResources() {
  try {
    return await import(pathToFileURL(join(ROOT, "hooks/lib/resources.mjs")).href);
  } catch {
    return emptyResources;
  }
}

function humanList(items, fmt, empty = "none") {
  return items.length ? items.map(fmt).join(", ") : empty;
}

export function formatHuman(report) {
  const lines = ["trantor patrol report"];
  const projectNames = sortedProjects(Object.keys(report.projects || {}));
  if (projectNames.length === 0) lines.push("projects: none");
  for (const p of projectNames) {
    const project = report.projects[p];
    lines.push(`\nproject ${displayProject(p)}`);
    lines.push(`  rows: ${humanList(project.rows, r => `${r.agent || "?"}/${r.kind || "?"}:${r.handle || "?"}`)}`);
    lines.push(`  live runners: ${humanList(project.runners, r => `${r.agent || "?"}(pid ${r.pid || "?"})`)}`);
    lines.push(`  cmux workspaces: ${humanList(project.workspaces, w => `${w.title || "?"}:${w.id || "?"}`)}`);
    if (project.devServers?.length) lines.push(`  dev servers: ${humanList(project.devServers, d => `${d.pid || "?"} ${d.cmd || ""}`.trim())}`);
  }
  lines.push(`\norphans: ${report.orphans.length}`);
  for (const item of report.orphans) lines.push(`  - ${item.type}: ${displayProject(item.project)} ${item.agent || item.title || item.handle || item.id || ""}`.trimEnd());
  lines.push(`ambiguous: ${report.ambiguous.length}`);
  for (const item of report.ambiguous) lines.push(`  - ${item.type}: ${item.agent || item.title || item.dir || item.id || ""}`.trimEnd());
  lines.push(`warnings: ${report.warnings?.length || 0}`);
  for (const item of report.warnings || []) {
    lines.push(`  - ${item.type}: ${displayProject(item.project)} ${item.agent} runs ${item.model}; expected ${item.expectedProvider}/*`);
  }
  lines.push(`reaped: ${report.reaped.length}`);
  for (const item of report.reaped) lines.push(`  - ${item.type}: ${item.path || item.output || ""}`.trimEnd());
  return `${lines.join("\n")}\n`;
}

export async function runPatrol({ args = [], resources = null, env = process.env, now = Date.now(), remove = rmSync } = {}) {
  const json = args.includes("--json");
  const reap = args.includes("--reap");
  const res = resources || await loadResources();
  let inv = { rows: [], runners: [], workspaces: [], devServers: [] };
  try { inv = await res.inventory?.(null) || inv; } catch {}
  const reaped = [];
  if (reap) {
    try {
      const output = await res.cleanDead?.(null);
      if (output) reaped.push({ type: "cleanDead", output: String(output).trim() });
    } catch {}
    reaped.push(...reapStaleArtifacts({ bus: busDir(env), runners: inv.runners, now, remove }));
  }
  const report = buildPatrolReport(inv, reaped, { bus: busDir(env) });
  return json ? `${JSON.stringify(report, null, 2)}\n` : formatHuman(report);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  runPatrol({ args: process.argv.slice(2) })
    .then(s => process.stdout.write(s))
    .catch(() => process.stdout.write(formatHuman(buildPatrolReport())));
}

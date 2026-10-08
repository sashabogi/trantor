import { readFileSync } from "node:fs";
import { join } from "node:path";
import { call } from "./core.mjs";

export const runnerRecord = (ctx, project, agent) => join(ctx.seatDir, `${project}-${agent}.runner.json`);

export function seatProcesses(ctx, project, agent) {
  if (ctx.env.CREW_NO_PROC_KILL === "1") return [];
  let label = agent, dir = ctx.dir;
  try {
    const record = JSON.parse(readFileSync(runnerRecord(ctx, project, agent), "utf8"));
    label = record.label;
    dir = record.dir;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const rows = call("ps", ["-axo", "pid=,ppid=,command="]).stdout.split("\n").map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match ? { pid: Number(match[1]), parent: Number(match[2]), command: match[3] } : null;
  }).filter(Boolean);
  const ids = new Set(rows.filter(row => row.command.endsWith(`crew-runner.mjs ${label} ${dir}`)).map(row => row.pid));
  let before;
  do { before = ids.size; for (const row of rows) if (ids.has(row.parent)) ids.add(row.pid); } while (ids.size > before);
  return [...ids];
}

export function signalProcesses(pids, signal) {
  for (const pid of pids) {
    try { process.kill(pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

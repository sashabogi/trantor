#!/usr/bin/env node
// trantor disk — report where the disk went; --clean runs the safe tier ONLY;
// install wires a Monday 09:00 launchd job; --weekly is what that job runs
// (safe clean, then exactly ONE summary message on the bus for the operator).
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { runDisk, formatHuman, fmtBytes, launchdPlist } from "../lib/disk.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function summaryLine(r, results) {
  const okN = results.filter((x) => x.ok).length;
  const failN = results.length - okN;
  const freed = r.plan.filter((p) => p.type === "build-dir").reduce((n, p) => n + (p.bytes || 0), 0);
  return `disk janitor: safe tier ${okN ? `cleaned ${okN} item(s)` : "nothing to clean"}${failN ? `, ${failN} FAILED` : ""} (~${fmtBytes(freed)} build output), now ${fmtBytes(r.freeBytes)} free of ${fmtBytes(r.totalBytes)} — report: trantor disk`;
}

async function sendWeeklyMessage(text) {
  // One message, signed, into the operator's project lane — never a wall of warnings.
  try {
    const { resolveProject, resolveHubInfo } = await import(join(ROOT, "lib/project.mjs"));
    const { sfetchJson } = await import(join(ROOT, "lib/signed-fetch.mjs"));
    const { loadOrCreate } = await import(join(ROOT, "lib/identity.mjs"));
    const project = resolveProject(process.cwd());
    const url = resolveHubInfo(project).url;
    await sfetchJson(`${url}/send`, {
      payload: { from: "trantor-disk", to: "all", project, kind: "disk", text },
      identity: loadOrCreate("trantor-disk", "agent"),
    });
  } catch (e) {
    process.stderr.write(`disk janitor: bus message failed: ${e.message}\n`);
  }
}

async function install() {
  if (platform() !== "darwin") {
    console.error("trantor disk install: launchd is macOS-only; run `trantor disk --clean` from cron elsewhere");
    process.exit(1);
  }
  const agentDir = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(agentDir, "com.trantor.disk.plist");
  const logPath = join(homedir(), ".agent-bus", "disk-launchd.log");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(plistPath, launchdPlist({ nodePath: process.execPath, scriptPath: join(ROOT, "bin", "disk.mjs"), logPath }));
  const uid = userInfo().uid;
  exec("launchctl", ["bootout", `gui/${uid}/com.trantor.disk`]);
  const r = exec("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
  if (r.status !== 0) {
    // bootout+bootstrap can race an existing job; load -w is the legacy fallback.
    exec("launchctl", ["load", "-w", plistPath]);
  }
  console.log(`installed: ${plistPath}\nruns every Monday 09:00 (safe tier only); result lands as one bus message. Log: ${logPath}`);
}

function exec(file, args) {
  return spawnSync(file, args, { encoding: "utf8" });
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
  console.log(`trantor disk — where the space went, and the provably safe slice to reclaim

  trantor disk              report only (also prints exactly what the safe tier would delete)
  trantor disk --dry-run    the same report, explicit
  trantor disk --clean      run the SAFE tier: unavailable simulators, build output in dead
                            seat worktrees (.next, target, desktop/src-tauri/target),
                            opencode sessions idle >14 days. Everything else stays.
  trantor disk --json       machine-readable report
  trantor disk install      Monday 09:00 launchd job (runs --weekly: clean + one bus message)`);
  process.exit(0);
}
if (args[0] === "install") { await install(); process.exit(0); }

const weekly = args.includes("--weekly");
const passArgs = weekly ? [...args, "--clean"] : args;
const { report, results, json } = await runDisk({ args: passArgs });
if (json) {
  process.stdout.write(`${JSON.stringify({ report, results }, null, 2)}\n`);
} else {
  process.stdout.write(formatHuman(report));
  if (results.length) {
    console.log(`\ncleaned: ${results.filter((r) => r.ok).length}, failed: ${results.filter((r) => !r.ok).length}`);
    for (const r of results.filter((r) => !r.ok)) console.log(`  FAILED ${r.type} ${r.path || r.id || ""}: ${r.error}`);
  }
}
if (weekly) await sendWeeklyMessage(summaryLine(report, results));

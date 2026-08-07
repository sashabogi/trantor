#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPatrolReport, reapStaleArtifacts, runPatrol } from "./bin/patrol.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
};

console.log("# trantor patrol tests");

const inv = {
  rows: [
    { project: "alpha", kind: "cmux", agent: "codex", handle: "pane-a" },
    { project: "alpha", kind: "cmux", agent: "kimi", handle: "pane-stale" },
    { project: "beta", kind: "cmuxws", agent: "_workspace", handle: "ws-dead" },
    { project: "", kind: "win", agent: "legacy", handle: "11" },
  ],
  runners: [
    { pid: 101, agent: "codex", dir: "/work/alpha" },
    { pid: 202, agent: "deepseek", dir: "/work/alpha" },
    { pid: 303, agent: "legacy", dir: "/work/legacyproj" },
    { pid: 404, agent: "mystery", dir: "" },
  ],
  workspaces: [
    { id: "ws-alpha", title: "trantor:alpha" },
    { id: "ws-gamma", title: "trantor:gamma" },
    { id: "notes", title: "personal notes" },
  ],
};

const report = buildPatrolReport(inv);
ok("projects are grouped from rows, runners, and trantor workspaces", ["", "alpha", "beta", "gamma", "legacyproj"].every(p => report.projects[p]));
ok("live runner without tracking row is an orphan", report.orphans.some(o => o.type === "live-runner-without-row" && o.project === "alpha" && o.agent === "deepseek"));
ok("workspace without a live runner is an orphan", report.orphans.some(o => o.type === "workspace-without-live-runner" && o.project === "gamma"));
ok("dead tracking row is an orphan", report.orphans.some(o => o.type === "dead-tracking-row" && o.project === "alpha" && o.agent === "kimi"));
ok("legacy rows and unparseable runners are ambiguous", report.ambiguous.some(a => a.type === "legacy-tracking-row") && report.ambiguous.some(a => a.type === "runner-without-project"));
ok("json shape is stable", report.projects.alpha.counts.rows === 2 && Array.isArray(report.orphans) && Array.isArray(report.ambiguous) && Array.isArray(report.reaped));

const internalBus = join(tmpdir(), "trantor-patrol-bus", ".agent-bus");
const internal = buildPatrolReport({
  runners: [{ pid: 505, agent: "claude", dir: join(internalBus, "fleet") }],
}, [], { bus: internalBus });
ok("bus-internal runners are listed but never flagged", internal.projects.fleet.counts.runners === 1 && internal.orphans.length === 0 && internal.ambiguous.length === 0);

const dir = mkdtempSync(join(tmpdir(), "trantor-patrol-"));
try {
  const bus = join(dir, ".agent-bus");
  const seats = join(bus, "seats");
  mkdirSync(seats, { recursive: true });
  const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
  const fresh = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  for (const name of ["alpha-codex.sh", "alpha-kimi.sh", "fresh-dead.sh"]) writeFileSync(join(seats, name), "#!/bin/bash\n");
  utimesSync(join(seats, "alpha-codex.sh"), old, old);
  utimesSync(join(seats, "alpha-kimi.sh"), old, old);
  utimesSync(join(seats, "fresh-dead.sh"), fresh, fresh);
  writeFileSync(join(bus, "kimi-startup-kimi_alpha.txt.consumed"), "old consumed");
  writeFileSync(join(bus, "kimi-startup-kimi_alpha.txt"), "old active");
  writeFileSync(join(bus, "kimi-startup-kimi_beta.txt.consumed"), "fresh consumed");
  utimesSync(join(bus, "kimi-startup-kimi_alpha.txt.consumed"), old, old);
  utimesSync(join(bus, "kimi-startup-kimi_alpha.txt"), old, old);
  utimesSync(join(bus, "kimi-startup-kimi_beta.txt.consumed"), fresh, fresh);

  const reaped = reapStaleArtifacts({ bus, runners: [{ agent: "codex", dir: "/work/alpha" }] });
  ok("reap removes only old seat scripts with no matching live runner", !existsSync(join(seats, "alpha-kimi.sh")) && existsSync(join(seats, "alpha-codex.sh")) && existsSync(join(seats, "fresh-dead.sh")));
  ok("reap removes old consumed startup stashes only", !existsSync(join(bus, "kimi-startup-kimi_alpha.txt.consumed")) && existsSync(join(bus, "kimi-startup-kimi_alpha.txt")) && existsSync(join(bus, "kimi-startup-kimi_beta.txt.consumed")));
  ok("reap reports exact removed artifacts", reaped.length === 2 && reaped.every(r => r.path));

  const fake = {
    inventory: () => inv,
    cleanDead: () => "pruned fake rows",
  };
  const json = JSON.parse(await runPatrol({ args: ["--json", "--reap"], resources: fake, env: { AGENT_BUS_DIR: bus } }));
  ok("--json includes projects, orphans, ambiguous, and reaped", json.projects.alpha && json.orphans.length > 0 && json.ambiguous.length > 0 && json.reaped.some(r => r.type === "cleanDead"));
  const human = await runPatrol({ args: [], resources: fake, env: { AGENT_BUS_DIR: bus } });
  ok("human report names project sections and counts", /project alpha/.test(human) && /orphans:/.test(human) && /ambiguous:/.test(human));

  const cli = spawnSync(process.execPath, [join(ROOT, "bin/patrol.mjs"), "--json"], {
    env: { ...process.env, HOME: dir, AGENT_BUS_DIR: bus },
    encoding: "utf8",
  });
  ok("CLI exits 0 even when the resources module is absent or empty", cli.status === 0, cli.stderr || cli.stdout);
  ok("CLI prints parseable stable JSON", !!JSON.parse(cli.stdout).projects);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

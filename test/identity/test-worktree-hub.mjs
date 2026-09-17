#!/usr/bin/env node
// Seat-worktree hub drill (#7893): kimi's relay MCP was spawned with {RELAY_AGENT: kimi} only, cwd
// inside ~/.agent-bus/worktrees/trantor/kimi, where git could not answer — the project resolved from
// the SEAT's dir name, missed the pin, and the tools silently hit the legacy localhost hub. This
// drill reproduces that spawn (no git on PATH) and asserts the MCP boots onto the pinned hub.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv, scrubIdentityEnv } from "../drill-env.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  condition ? pass++ : fail++;
};

// Boot one MCP server from a seat worktree and capture its startup line (and any register error,
// which now names the hub too). Resolves with the combined stderr.
function bootMcp({ bus, worktree, env: envOverrides = {} }) {
  return new Promise((done) => {
    const kid = spawn(process.execPath, [join(ROOT, "mcp.mjs")], {
      cwd: worktree,
      env: (() => {
        // mcp.mjs reads CLAUDE_PROJECT_DIR before cwd — the host's own project must not lend itself.
        const env = drillEnv({ RELAY_AGENT: "kimi", AGENT_BUS_DIR: bus, HOME: join(bus, "..", "home"), ...envOverrides });
        delete env.CLAUDE_PROJECT_DIR;
        return env;
      })(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    const timer = setTimeout(() => finish("timeout: no startup line within 30s"), 30_000);
    const finish = (why) => {
      clearTimeout(timer);
      try { kid.kill("SIGKILL"); } catch {}
      done(err + (why ? `\n[${why}]` : ""));
    };
    kid.stderr.on("data", (d) => {
      err += d;
      if (err.includes("[trantor-mcp] connected as")) finish();
    });
    kid.on("error", (e) => finish(`spawn error: ${e.message}`));
  });
}

const setup = ({ pin }) => {
  const work = mkdtempSync(join(tmpdir(), "trantor-wt-hub-"));
  const bus = join(work, "bus");
  mkdirSync(join(bus, "worktrees", "acme", "kimi"), { recursive: true });
  mkdirSync(join(work, "home"), { recursive: true });
  if (pin) writeFileSync(join(bus, "config.json"), JSON.stringify({ hubs: { acme: "http://127.0.0.1:1" } }));
  return { work, bus, worktree: join(bus, "worktrees", "acme", "kimi") };
};

scrubIdentityEnv();
console.log("# relay MCP hub resolution from a seat worktree (#7893)");

// ---- in-process: the path rule itself ----
{
  const t = setup({ pin: true });
  process.env.AGENT_BUS_DIR = t.bus;
  const { resolveProject, worktreeProject } = await import(join(ROOT, "lib", "project.mjs"));
  ok("a seat worktree resolves to its parent project, not the seat dir name",
    resolveProject(t.worktree) === "acme", resolveProject(t.worktree));
  ok("a cwd deeper inside the worktree resolves the same way",
    resolveProject(join(t.worktree, "sub", "dir")) === "acme");
  ok("the worktrees root itself is not a project",
    worktreeProject(join(t.bus, "worktrees")) === "");
  ok("a directory outside the bus is untouched by the path rule",
    resolveProject(join(t.work, "home")) === "home");
  ok("RELAY_PROJECT still wins over the path rule",
    resolveProject(t.worktree, { RELAY_PROJECT: "x" }) === "x");
  delete process.env.AGENT_BUS_DIR;
  rmSync(t.work, { recursive: true, force: true });
}

// ---- the kimi incident, reproduced: only RELAY_AGENT, no git, pinned project ----
{
  const t = setup({ pin: true });
  const out = await bootMcp({ bus: t.bus, worktree: t.worktree, env: { PATH: "/nonexistent" } });
  ok("the MCP boots as the PARENT project's seat (no git on PATH)",
    /connected as kimi:acme in acme ->/.test(out), out.split("\n").filter(Boolean).pop());
  ok("the startup line names the pinned hub and the rule that chose it",
    /-> hub http:\/\/127\.0\.0\.1:1 via pin/.test(out), out.split("\n").filter(Boolean).pop());
  rmSync(t.work, { recursive: true, force: true });
}

// ---- no pin for this project: the fallback is NAMED, never silent ----
{
  const t = setup({ pin: false });
  const out = await bootMcp({ bus: t.bus, worktree: t.worktree, env: { PATH: "/nonexistent" } });
  ok("an unpinned project's fallback hub is labeled as a fallback",
    /hub http:\/\/127\.0\.0\.1:4477 via default \(fallback, not a pin\)/.test(out),
    out.split("\n").filter(Boolean).pop());
  rmSync(t.work, { recursive: true, force: true });
}

// ---- the connect-stamped belt: env wins over the pin, and says so ----
{
  const t = setup({ pin: true });
  const out = await bootMcp({ bus: t.bus, worktree: t.worktree,
    env: { PATH: "/nonexistent", RELAY_URL: "http://127.0.0.1:2", RELAY_PROJECT: "acme" } });
  ok("an explicit RELAY_URL env override wins and is labeled via env",
    /-> hub http:\/\/127\.0\.0\.1:2 via env/.test(out), out.split("\n").filter(Boolean).pop());
  rmSync(t.work, { recursive: true, force: true });
}

console.log(`# worktree-hub: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);

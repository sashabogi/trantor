#!/usr/bin/env node
// `trantor connect` relay-env drill (#7893). connect used to build the relay entry with `||=`, so an
// entry written by an older connect (kimi's was {RELAY_AGENT: kimi} only) was never refreshed, and
// no CLI carried RELAY_URL/RELAY_PROJECT — an MCP spawned with a scrubbed env had nothing to
// resolve from. Every case runs in a temp HOME + temp bus dir with stub CLIs on PATH.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { drillEnv } from "../drill-env.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PIN = "http://127.0.0.1:3";

let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  condition ? pass++ : fail++;
};

const stub = (dir, name) => {
  const p = join(dir, name);
  writeFileSync(p, "#!/bin/sh\nexit 0\n");
  chmodSync(p, 0o755);
};

// Temp machine: HOME, a bus dir pinning project "acme", and a git repo named acme to run connect in.
// `configs` values are written as JSON; `raw` values are written verbatim (TOML bodies).
const setup = (clis, configs = {}, raw = {}) => {
  const work = mkdtempSync(join(tmpdir(), "trantor-connect-env-"));
  const home = join(work, "home");
  const bus = join(work, "bus");
  const fakebin = join(work, "bin");
  const repo = join(work, "acme");
  mkdirSync(fakebin, { recursive: true });
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(bus, "worktrees", "acme"), { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const c of clis) stub(fakebin, c);
  stub(fakebin, "graft");
  writeFileSync(join(bus, "config.json"), JSON.stringify({ hubs: { acme: PIN } }));
  execSync("git init -q", { cwd: repo });
  for (const [rel, body] of Object.entries(configs)) writeOne(join(home, rel), JSON.stringify(body, null, 2));
  for (const [rel, body] of Object.entries(raw)) writeOne(join(home, rel), body);
  const run = (args = []) => spawnSync(process.execPath, [join(ROOT, "bin", "connect.mjs"), ...args], {
    cwd: repo,
    env: drillEnv({ HOME: home, AGENT_BUS_DIR: bus, PATH: `${fakebin}:/usr/bin:/bin` }),
    encoding: "utf8",
  });
  return { work, home, bus, run };
};
const writeOne = (p, body) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
};

const relayEnvOf = (home, rel, key = "mcpServers") => {
  try { return JSON.parse(readFileSync(join(home, rel), "utf8"))?.[key]?.relay?.env || null; }
  catch { return null; }
};

console.log("# trantor connect — relay entry env stamp + refresh (#7893)");

// 1. fresh configs: every wired CLI carries agent + hub + project.
{
  const t = setup(["gemini", "kimi"]);
  const r = t.run();
  ok("connect reports the project and hub it stamps", r.status === 0 && new RegExp(`project: acme, hub: ${PIN}`).test(r.stdout), r.stderr || r.stdout);
  const kimi = relayEnvOf(t.home, ".kimi/mcp.json");
  ok("kimi relay env carries agent and pinned hub, never the project (global config, #7893)",
    kimi?.RELAY_AGENT === "kimi" && kimi?.RELAY_URL === PIN && !("RELAY_PROJECT" in kimi), JSON.stringify(kimi));
  const gemini = relayEnvOf(t.home, ".gemini/settings.json");
  ok("gemini relay env carries the same stamp for its own agent",
    gemini?.RELAY_AGENT === "gemini" && gemini?.RELAY_URL === PIN && !("RELAY_PROJECT" in gemini), JSON.stringify(gemini));
  rmSync(t.work, { recursive: true, force: true });
}

// 2. THE INCIDENT SHAPE: a stale entry with RELAY_AGENT only — refreshed, user keys kept.
{
  const t = setup(["kimi"], { ".kimi/mcp.json": { mcpServers: { relay: { command: "node", args: ["/old/mcp.mjs"], env: { RELAY_AGENT: "kimi", CUSTOM: "keep" } } } } });
  const r = t.run();
  const env = relayEnvOf(t.home, ".kimi/mcp.json");
  ok("a stale RELAY_AGENT-only entry is refreshed with the hub",
    env?.RELAY_URL === PIN && !("RELAY_PROJECT" in env), JSON.stringify(env));
  ok("the refresh keeps the user's own env keys and command",
    env?.CUSTOM === "keep" && relayCommand(t.home, ".kimi/mcp.json") === "/old/mcp.mjs", JSON.stringify(env));
  ok("the refresh is reported and backed up",
    /kimi\s+wired/.test(r.stdout) && existsSync(join(t.home, ".kimi", "mcp.json.bak-" + new Date().toISOString().slice(0, 10))), r.stdout);
  rmSync(t.work, { recursive: true, force: true });
}

// 3. idempotence: a current entry reports already wired, byte-untouched.
{
  const t = setup(["kimi"]);
  t.run();
  const before = readFileSync(join(t.home, ".kimi", "mcp.json"), "utf8");
  const r = t.run();
  ok("a current entry reports already wired", r.status === 0 && /kimi\s+already wired/.test(r.stdout), r.stdout);
  ok("already wired leaves the config byte-identical", readFileSync(join(t.home, ".kimi", "mcp.json"), "utf8") === before);
  rmSync(t.work, { recursive: true, force: true });
}

// 4. codex TOML: a stale single-line env table is refreshed in place; a custom one is left alone.
{
  const t = setup(["codex"], {}, { ".codex/config.toml": '[mcp_servers.relay]\ncommand = "node"\nargs = ["/old/mcp.mjs"]\nenv = { RELAY_AGENT = "codex" }\n' });
  const r = t.run();
  const toml = readFileSync(join(t.home, ".codex", "config.toml"), "utf8");
  ok("codex's stale relay env line is refreshed in place",
    /relay env refreshed/.test(r.stdout) && toml.includes(`env = { RELAY_AGENT = "codex", RELAY_URL = "${PIN}" }`), toml);
  rmSync(t.work, { recursive: true, force: true });
}
{
  const custom = '[mcp_servers.relay]\ncommand = "node"\nenv = {\n  RELAY_AGENT = "codex",\n  TOKEN = "x",\n}\n';
  const t = setup(["codex"], {}, { ".codex/config.toml": custom });
  const r = t.run();
  const toml = readFileSync(join(t.home, ".codex", "config.toml"), "utf8");
  ok("a hand-rolled multi-line codex env table is left untouched and named",
    /relay env kept \(custom shape\)/.test(r.stdout) && toml.startsWith(custom), toml);
  rmSync(t.work, { recursive: true, force: true });
}

// 5. opencode stays host-neutral: no RELAY_URL/RELAY_PROJECT stamped into a multi-seat config.
{
  const t = setup(["opencode"]);
  t.run();
  const env = JSON.parse(readFileSync(join(t.home, ".config/opencode/opencode.json"), "utf8"))?.mcp?.relay?.environment || {};
  ok("opencode's environment carries no project/hub stamp (hosted seats keep ambient env)",
    !("RELAY_URL" in env) && !("RELAY_PROJECT" in env) && env.RELAY_AGENT_FALLBACK === "opencode", JSON.stringify(env));
  rmSync(t.work, { recursive: true, force: true });
}

function relayCommand(home, rel, key = "mcpServers") {
  try { return JSON.parse(readFileSync(join(home, rel), "utf8"))?.[key]?.relay?.args?.[0] || ""; } catch { return ""; }
}

console.log(`# connect-relay-env: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);

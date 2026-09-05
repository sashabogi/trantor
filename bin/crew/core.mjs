import { accessSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export function commandExists(name, env = process.env) {
  for (const dir of String(env.PATH || "").split(":")) {
    try { accessSync(join(dir, name), constants.X_OK); return true; }
    catch {}
  }
  return false;
}

export function call(command, args = [], options = {}) {
  const spawnOptions = {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    env: options.env || process.env,
    input: options.input,
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
  };
  let result = spawnSync(command, args, spawnOptions);
  if (result.error?.code === "ENOEXEC") result = spawnSync("/bin/sh", [command, ...args], spawnOptions);
  return {
    ok: !result.error && result.status === 0,
    status: result.status ?? 1,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
  };
}

export function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

export function formatCommand(command, args = []) {
  return [command, ...args].map(shellQuote).join(" ");
}

export function run(ctx, command, args = [], options = {}) {
  const rendered = options.rendered || formatCommand(command, args);
  if (ctx.dry) {
    console.log(`[dry] ${rendered}`);
    return { ok: true, status: 0, stdout: "", stderr: "" };
  }
  const result = spawnSync(command, args, {
    cwd: options.cwd || ctx.dir,
    encoding: "utf8",
    env: options.env || process.env,
    stdio: options.stdio || "ignore",
  });
  return { ok: !result.error && result.status === 0, status: result.status ?? 1 };
}

function projectFromGit(dir) {
  const result = call("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
  return result.ok && result.stdout ? basename(result.stdout) : basename(dir);
}

function readConfig(home, env) {
  const base = env.AGENT_BUS_DIR || join(home, ".agent-bus");
  try { return JSON.parse(readFileSync(join(base, "config.json"), "utf8")); }
  catch { return {}; }
}

function resolveHub(home, project, env) {
  if (env.CREW_HUB) return env.CREW_HUB;
  const config = readConfig(home, env);
  return config.hubs?.[project] || env.RELAY_URL || config.url || "http://127.0.0.1:4477";
}

function selectMux(env, have) {
  if (env.CREW_MUX === "herdr" && !have.herdr) {
    throw new Error("CREW_MUX=herdr but herdr is not installed — user-local (no sudo): curl -fsSL https://herdr.dev/install.sh | sh — see https://herdr.dev");
  }
  if (env.CREW_MUX) return env.CREW_MUX;
  if (have.herdr) return "herdr";
  if (have.cmux) return "cmux";
  if (have.tmux) return "tmux";
  return "terminal";
}

export function createContext(command, env = process.env) {
  const dir = env.PWD || process.cwd();
  const home = env.HOME || "";
  const project = env.RELAY_PROJECT || projectFromGit(dir);
  const have = {
    herdr: commandExists("herdr", env),
    tmux: commandExists("tmux", env),
    cmux: existsSync("/Applications/cmux.app") || commandExists("cmux", env),
  };
  const ctx = {
    command,
    dir,
    home,
    project,
    root: ROOT,
    hub: resolveHub(home, project, env),
    statePath: join(home, ".agent-bus", "crew-windows.txt"),
    seatDir: join(home, ".agent-bus", "seats"),
    dry: env.CREW_DRY_RUN === "1",
    have,
    env,
  };
  mkdirSync(dirname(ctx.statePath), { recursive: true });
  ctx.mux = selectMux(env, have);
  return ctx;
}

export function parseJsonOutput(text) {
  const start = String(text).search(/[\[{]/);
  if (start < 0) return null;
  try { return JSON.parse(String(text).slice(start)); }
  catch { return null; }
}

export function appleScript(script) {
  return call("osascript", [], { input: script });
}

export function appleScriptString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function gridColumns(size) {
  let columns = 1;
  while (columns * columns < size) columns += 1;
  return columns;
}

export function runnerCommand(ctx, agent, model = "") {
  return `cd ${shellQuote(ctx.dir)} && CREW_MODEL=${shellQuote(model)} RELAY_PROJECT=${shellQuote(ctx.project)} RELAY_URL=${shellQuote(ctx.hub)} node ${shellQuote(join(ROOT, "bin/crew-runner.mjs"))} ${shellQuote(agent)} ${shellQuote(ctx.dir)}`;
}

export function listPids(pattern) {
  const result = call("pgrep", ["-f", pattern]);
  return result.ok ? result.stdout.split(/\s+/).filter(Boolean) : [];
}

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { workspacePane, splitPane } from "./crew/herdr.mjs";

const ROOT = dirname(import.meta.dirname);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const herdr = args => JSON.parse(execFileSync("herdr", args, { encoding: "utf8", timeout: 30000 }));
const read = path => existsSync(path) ? readFileSync(path, "utf8") : "";

export function checkSocketHome(home) {
  const socket = join(home, ".config", "herdr", "herdr.sock");
  if (Buffer.byteLength(socket) >= (process.platform === "darwin" ? 104 : 108)) {
    throw new Error(`drill HOME socket path is too long: ${socket}; use a shorter TRANTOR_DRILL_WORLD inside .agent-bus-out`);
  }
  return socket;
}

export function isolatedEnv(home, bus, overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(RELAY_|TRANTOR_|CLAUDE_CODE_|HERDR_|AGENT_BUS_)/.test(key) || key === "CLAUDECODE") delete env[key];
  }
  return { ...env, HOME: home, AGENT_BUS_DIR: bus, RELAY_DATA_DIR: bus, ...overrides };
}

export async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise(resolve => child.once("close", resolve)), sleep(2000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

export async function startDrillHub(home, bus, auth = "enforce") {
  mkdirSync(bus, { recursive: true });
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const env = isolatedEnv(home, bus, {
    RELAY_PORT: String(port), RELAY_HOST: "127.0.0.1", RELAY_URL: url,
    RELAY_AUTH: auth, RELAY_ENROLL: "tofu", RELAY_STORE: "json",
  });
  const child = spawn(process.execPath, [join(ROOT, "hub.mjs")], { env, stdio: "ignore" });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })).ok) return { child, env, url };
    } catch { /* The private hub has not bound its port yet. */ }
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  await stopChild(child);
  throw new Error("private drill hub did not become ready");
}

export function appVerdict(kind, trace, panics = "") {
  if (/\b(?:FAILED|FAIL|ERROR)\b/.test(trace)) return false;
  if (kind === "ask") return /ask-drill open PASS/.test(trace) && /ask-drill cold PASS/.test(trace) && /ask-drill PASS:/.test(trace);
  if (kind === "handoff") return /handoff-drill PASS:/.test(trace) && /handoff-drill verdict exit=0/.test(trace);
  return /key-drill verdict exit=0/.test(trace) && !/skipped/.test(trace)
    && [1, 2, 3].every(pass => trace.includes(`pass=${pass} posted keyDown+keyUp`))
    && (kind !== "key-throw" || panics.includes("TaoObjcExceptionDrill"));
}

async function launchApp(kind, env, bus) {
  const binary = process.env.TRANTOR_DRILL_APP || "/Applications/Trantor.app/Contents/MacOS/Trantor";
  if (!existsSync(binary)) throw new Error(`installed app missing: ${binary}; no build/install attempted`);
  const tracePath = join(bus, "app-trace.log");
  const panicPath = join(bus, "app-panics.log");
  const offset = read(tracePath).length;
  const panicOffset = read(panicPath).length;
  const child = spawn(binary, [], { env, stdio: "ignore", timeout: 180000, killSignal: "SIGKILL" });
  let spawnError = null;
  child.once("error", error => { spawnError = error; });
  const deadline = Date.now() + 180000;
  let trace = "";
  try {
    await sleep(1000);
    execFileSync("osascript", ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${child.pid}) to true`], { timeout: 10000, stdio: "ignore" });
    while (Date.now() < deadline) {
      trace = read(tracePath).slice(offset);
      if (spawnError) throw spawnError;
      if (appVerdict(kind, trace, read(panicPath).slice(panicOffset))) return `${tracePath}: ${trace.trim().split("\n").filter(line => /PASS|survived|verdict/.test(line)).join("; ")}`;
      if (/\b(?:FAILED|FAIL|ERROR)\b/.test(trace) || child.exitCode !== null || child.signalCode !== null) break;
      await sleep(500);
    }
    throw new Error(`${kind}: no complete app proof (exit=${child.exitCode} signal=${child.signalCode}); ${tracePath}: ${trace.trim().slice(-500)}`);
  } finally {
    await stopChild(child);
    // The app normally closes these in its own finally. If it timed out first, only this
    // launch's trace can authorize cleanup; never sweep the shared herdr workspace list.
    for (const match of trace.matchAll(/ask-drill (?:open|cold) herdr workspace=(\S+)/g)) {
      try { herdr(["workspace", "close", match[1]]); } catch { /* Already closed by the app. */ }
    }
  }
}

export async function runAppDrills({ world, proj, project, run }) {
  // The HOME socket pathname must fit sockaddr_un even when it is a symlink.
  const home = world;
  const bus = join(home, "app-bus");
  mkdirSync(join(home, ".config", "herdr"), { recursive: true });
  const socket = checkSocketHome(home);
  if (!existsSync(socket)) symlinkSync(join(homedir(), ".config", "herdr", "herdr.sock"), socket);
  let hub;
  try {
    hub = await startDrillHub(home, bus, "off");
    await fetch(`${hub.url}/project`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project, brief: "Throwaway drill project" }) });
    writeFileSync(join(bus, "config.json"), JSON.stringify({ url: hub.url, hubs: { [project]: hub.url }, contextWindow: 200000 }));
    const env = { ...hub.env, TRANTOR_DEV_ROOT: dirname(proj), TRANTOR_ROOT: ROOT };
    await run("S6-ask · app AskUserQuestion", () => launchApp("ask", { ...env, TRANTOR_ASK_DRILL: project }, bus));
    const created = herdr(["workspace", "create", "--cwd", proj, "--label", `tt-dead-drill-${process.pid}`, "--no-focus"]);
    const workspace = created.result.workspace.workspace_id;
    const pane = created.result.root_pane.pane_id;
    try {
      const sid = "00000000-0000-4000-8000-000000000092";
      const transcripts = join(home, ".claude", "projects", proj.replace(/[/.]/g, "-"));
      mkdirSync(transcripts, { recursive: true });
      writeFileSync(join(transcripts, `${sid}.jsonl`), JSON.stringify({ type: "assistant", sessionId: sid, cwd: proj, timestamp: new Date().toISOString(), message: { model: "claude-sonnet-4-5", role: "assistant", usage: { input_tokens: 184000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: "text", text: "dead drill session" }] } }) + "\n");
      writeFileSync(join(bus, "crew-windows.txt"), `${project}\therdrws\t__ws__\t${workspace}\n${project}\torch\torchestrator\t${pane}\n`);
      writeFileSync(join(bus, "orch-sessions.txt"), `${project}\t${sid}\n`);
      await run("S6-handoff · app dead-pane guard", async () => {
        const before = herdr(["pane", "process-info", "--pane", pane]).result.process_info.shell_pid;
        const evidence = await launchApp("handoff", { ...env, TRANTOR_HANDOFF_DRILL: project }, bus);
        const after = herdr(["pane", "process-info", "--pane", pane]).result.process_info.shell_pid;
        if (!before || before !== after) throw new Error("dead-pane shell did not survive");
        return `${evidence}; shell ${after} survived`;
      });
      // Key dispatch needs this real pane mounted; closing it after handoff left a stale tab.
      for (const mode of ["post", "throw"]) {
        await run(`S6-key-${mode} · app key dispatch`, () => launchApp(`key-${mode}`, {
          ...env, TRANTOR_KEY_DRILL: mode, TRANTOR_KEY_DRILL_PROJECT: project,
        }, bus));
      }
    } finally { herdr(["workspace", "close", workspace]); }
  } catch (error) {
    for (const name of ["S6-ask", "S6-handoff", "S6-key-post", "S6-key-throw"]) await run(`${name} · app setup`, () => { throw error; });
  } finally { if (hub) await stopChild(hub.child); }
}

export async function crewWorkspaceDrill({ proj, workspace }) {
  if (!workspace) throw new Error("S1 left no project workspace");
  const ctx = { env: process.env, have: { herdr: true } };
  const host = workspacePane(ctx, workspace, proj);
  if (!host) throw new Error("no project-local host pane");
  const foreign = herdr(["workspace", "create", "--cwd", proj, "--label", `tt-focus-drill-${process.pid}`, "--focus"]);
  const panes = [];
  try {
    for (let i = 0; i < 4; i++) {
      const pane = splitPane(ctx, panes.at(-1) || host, "right", proj);
      if (!pane) throw new Error("crew split failed");
      panes.push(pane);
    }
    const rows = herdr(["pane", "list"]).result.panes;
    if (!panes.every(id => rows.some(row => row.pane_id === id && row.workspace_id === workspace && row.cwd === proj))) throw new Error("a crew split landed outside the project workspace/cwd");
    return `focused=${foreign.result.workspace.workspace_id}; seats=${panes.join(",")}; workspace=${workspace}; cwd=${proj}`;
  } finally {
    for (const pane of panes) herdr(["pane", "close", pane]);
    herdr(["workspace", "close", foreign.result.workspace.workspace_id]);
  }
}

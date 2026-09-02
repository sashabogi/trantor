#!/usr/bin/env node
// Hosted-seat identity drill (#5738). OpenCode's global MCP config is generated in a temp HOME,
// then the real MCP and runner talk to a recording hub. No live config, hub, or bus state is used.
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "trantor-hosted-identity-"));
const home = join(work, "home");
const bus = join(home, ".agent-bus");
const repo = join(work, "repo");
const fakebin = join(work, "bin");
mkdirSync(bus, { recursive: true });
mkdirSync(repo, { recursive: true });
mkdirSync(fakebin, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = "") => {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  condition ? pass++ : fail++;
};
const waitUntil = async (read, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return read();
};

const opencode = join(fakebin, "opencode");
writeFileSync(opencode, "#!/bin/sh\nexit 0\n");
chmodSync(opencode, 0o755);
const configPath = join(home, ".config", "opencode", "opencode.json");
mkdirSync(join(home, ".config", "opencode"), { recursive: true });
writeFileSync(configPath, JSON.stringify({
  mcp: {
    relay: {
      type: "local", command: ["node", join(ROOT, "mcp.mjs")], enabled: true,
      environment: { RELAY_AGENT: "opencode", EXTRA_SENTINEL: "kept" },
    },
  },
}, null, 2));

const registrations = [];
const sends = [];
let pollQueue = [];
const hub = http.createServer((req, res) => {
  let raw = "";
  req.on("data", chunk => { raw += chunk; });
  req.on("end", () => {
    const url = new URL(req.url, "http://test");
    const reply = body => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    if (url.pathname === "/register") { registrations.push(body); return reply({ ok: true, peers: [] }); }
    if (url.pathname === "/send") { sends.push(body); return reply({ ok: true, id: sends.length }); }
    if (url.pathname === "/poll") {
      const messages = pollQueue.splice(0, 1);
      const since = Number(url.searchParams.get("since")) || 0;
      return setTimeout(() => reply({ messages, cursor: since + messages.length }), messages.length ? 0 : 30);
    }
    if (url.pathname === "/inbox") return reply({ messages: [], cursor: 0 });
    if (url.pathname === "/lessons") return reply({ lessons: [] });
    if (url.pathname === "/enroll") return reply({ ok: true });
    return reply({ ok: true });
  });
});
await new Promise(resolve => hub.listen(0, "127.0.0.1", resolve));
const relayUrl = `http://127.0.0.1:${hub.address().port}`;

let mcp;
let runner;
try {
  console.log("# hosted OpenCode seat identity");

  const connected = spawnSync(process.execPath, [join(ROOT, "bin", "connect.mjs")], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, PATH: `${fakebin}:/usr/bin:/bin` },
    encoding: "utf8",
  });
  ok("connect migrates the existing OpenCode relay entry", connected.status === 0 && /opencode\s+wired/.test(connected.stdout || ""), connected.stderr || connected.stdout);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const configuredEnv = config.mcp.relay.environment;
  ok("the global config no longer pins RELAY_AGENT or RELAY_SESSION",
    !Object.hasOwn(configuredEnv, "RELAY_AGENT") && !Object.hasOwn(configuredEnv, "RELAY_SESSION"), JSON.stringify(configuredEnv));
  ok("OpenCode remains the fallback and unrelated config is preserved",
    configuredEnv.RELAY_AGENT_FALLBACK === "opencode" && configuredEnv.EXTRA_SENTINEL === "kept", JSON.stringify(configuredEnv));

  const mcpEnv = {
    ...process.env,
    HOME: home,
    AGENT_BUS_DIR: bus,
    RELAY_URL: relayUrl,
    RELAY_AGENT: "qwen",
    RELAY_PROJECT: "identity-drill",
    RELAY_HEARTBEAT_MS: "600000",
    ...configuredEnv,
  };
  delete mcpEnv.RELAY_SESSION;
  mcp = spawn(process.execPath, [join(ROOT, "mcp.mjs")], { cwd: repo, env: mcpEnv, stdio: ["pipe", "pipe", "pipe"] });
  let rpcBuffer = "";
  const pending = new Map();
  mcp.stdout.on("data", chunk => {
    rpcBuffer += chunk;
    let newline;
    while ((newline = rpcBuffer.indexOf("\n")) >= 0) {
      const line = rpcBuffer.slice(0, newline);
      rpcBuffer = rpcBuffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        if (message.id && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      } catch {}
    }
  });
  let rpcId = 0;
  const rpc = (method, params) => {
    const id = ++rpcId;
    const answer = new Promise((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`RPC timed out: ${method}`));
      }, 15_000);
    });
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return answer;
  };
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "identity-drill", version: "0" } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await rpc("tools/call", { name: "relay_send", arguments: { to: "host:identity-drill", text: "identity proof" } });
  const seatSend = sends.find(message => message.text === "identity proof");
  ok("the hosted seat's MCP sends as qwen:identity-drill", seatSend?.from === "qwen:identity-drill", JSON.stringify(seatSend));
  ok("the same MCP registers under the qwen seat id",
    registrations.some(message => message.session === "qwen:identity-drill"), JSON.stringify(registrations));
  mcp.kill("SIGKILL");
  mcp = undefined;

  const turnLog = join(work, "turns.log");
  writeFileSync(opencode, `#!/bin/sh\nprintf '%s|%s|%s\\n' "$RELAY_SESSION" "$RELAY_AGENT" "$*" >> "$IDENTITY_TURN_LOG"\necho done\nexit 0\n`);
  chmodSync(opencode, 0o755);
  pollQueue = [{
    id: 1,
    from: "host:identity-drill",
    to: "qwen:identity-drill",
    project: "identity-drill",
    kind: "contract",
    text: "contract: reply to the qwen seat #5738",
  }];
  runner = spawn(process.execPath, [join(ROOT, "bin", "crew-runner.mjs"), "qwen", repo], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      AGENT_BUS_DIR: bus,
      PATH: `${fakebin}:/usr/bin:/bin`,
      RELAY_URL: relayUrl,
      RELAY_PROJECT: "identity-drill",
      RELAY_AGENT: "qwen",
      TRANTOR_NO_WORKTREE: "1",
      CREW_KICKOFF: "identity kickoff",
      IDENTITY_TURN_LOG: turnLog,
    },
    stdio: "ignore",
  });
  const delivered = await waitUntil(() => {
    if (!existsSync(turnLog)) return "";
    const turns = readFileSync(turnLog, "utf8");
    return turns.includes("contract: reply to the qwen seat #5738") ? turns : "";
  });
  ok("a reply addressed to qwen:identity-drill is delivered by the qwen runner",
    delivered.includes("contract: reply to the qwen seat #5738"));
  ok("the delivered turn inherits one exact session and agent identity",
    delivered.includes("qwen:identity-drill|qwen|"), delivered.slice(0, 160));
} catch (error) {
  fail++;
  console.log(`  FAIL  harness error — ${error?.stack || error}`);
} finally {
  try { mcp?.kill("SIGKILL"); } catch {}
  try { runner?.kill("SIGKILL"); } catch {}
  await new Promise(resolve => hub.close(resolve));
  rmSync(work, { recursive: true, force: true });
}

console.log(`\nhosted identity drills: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

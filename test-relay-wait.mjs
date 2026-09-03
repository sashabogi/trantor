#!/usr/bin/env node
// trantor relay_wait long-poll drill — the parking tool must survive a QUIET wait.
//
// The bug this pins (found live 2026-08-19, crebral-scribe): when MCP reads moved onto the shared
// signed client, relay_wait inherited its 1.5s default deadline while asking the hub to hold the
// poll for up to 110s. Every quiet wait was aborted at 1.5s and surfaced as "hub 0 on /poll" —
// parking was dead, and the tool only ever "worked" when a message happened to beat the abort.
// The drill drives the REAL mcp.mjs over the real MCP stdio protocol against the REAL hub.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "./drill-env.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log("# trantor relay_wait long-poll drill");

const W = mkdtempSync(join(tmpdir(), "trantor-wait-"));
mkdirSync(join(W, ".agent-bus"), { recursive: true });
const PORT = 47861, HUB = `http://127.0.0.1:${PORT}`;
const hub = spawn("node", [join(ROOT, "hub.mjs")], {
  env: { ...drillEnv(), RELAY_DATA_DIR: W, HOME: W, RELAY_PORT: String(PORT), PORT: String(PORT), TRANTOR_NO_UPDATE_CHECK: "1" },
  stdio: ["ignore", "ignore", "pipe"],
});
await sleep(900);

// the REAL MCP server, as a stdio JSON-RPC peer
const mcp = spawn("node", [join(ROOT, "mcp.mjs")], {
  cwd: W,
  env: { ...drillEnv(), HOME: W, AGENT_BUS_DIR: join(W, ".agent-bus"), RELAY_URL: HUB,
    RELAY_SESSION: "waiter:waitproj", RELAY_PROJECT: "waitproj", RELAY_HEARTBEAT_MS: "600000" },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
const pending = new Map();
mcp.stdout.on("data", d => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
  }
});
let rpcId = 0;
function rpc(method, params, timeoutMs = 30000) {
  const id = ++rpcId;
  const p = new Promise((res, rej) => {
    pending.set(id, res);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); } }, timeoutMs);
  });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return p;
}
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "drill", version: "0" } });
mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const call = (name, args, timeoutMs) => rpc("tools/call", { name, arguments: args }, timeoutMs);
const text = (r) => r?.result?.content?.[0]?.text ?? JSON.stringify(r?.result ?? r?.error ?? {});

// ---- 1. a QUIET wait must time out cleanly, not die at the client's 1.5s default -------
{
  const t0 = Date.now();
  const r = await call("relay_wait", { timeout: 4 });
  const took = Date.now() - t0;
  const out = text(r);
  ok("a quiet 4s wait returns 'timed out', not an error", /timed out/.test(out), out.slice(0, 90));
  ok("...and it actually WAITED (>3s), instead of aborting at 1.5s", took > 3000, `${took}ms`);
}

// ---- 2. a message arriving MID-WAIT is delivered ----------------------------------------
{
  setTimeout(async () => {
    await fetch(`${HUB}/send`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "peer:waitproj", to: "waiter:waitproj", project: "waitproj", text: "wake up, drill message" }) });
  }, 2200);
  const t0 = Date.now();
  const r = await call("relay_wait", { timeout: 30 });
  const took = Date.now() - t0;
  const out = text(r);
  ok("a message landing mid-wait is delivered", /wake up, drill message/.test(out), out.slice(0, 90));
  ok("...promptly (the poll returned on arrival, not at the cap)", took > 2000 && took < 15000, `${took}ms`);
}

// ---- 3. the peer row is truthful from BOOT: the MCP stamps its own version -------------
// Only the tool-use heartbeat hook used to write hookVersion, so a fresh-but-idle session wore
// its dead predecessor's version until its first tool call (misread twice on 2026-08-19).
{
  const r = await (await fetch(`${HUB}/peers`)).json();
  const me = (r.peers || []).find(p => p.session === "waiter:waitproj");
  const expected = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
  ok("the MCP's own /register stamps hookVersion at boot, before any tool call",
    me?.hookVersion === expected, `row=${me?.hookVersion} expected=${expected}`);
}

mcp.kill(); hub.kill();
rmSync(W, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

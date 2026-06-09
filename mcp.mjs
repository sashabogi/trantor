#!/usr/bin/env node
// agent-bus MCP server — gives ANY MCP-capable agent (Claude Code, Codex, Gemini, …)
// tools to talk to OTHER live agent sessions through the relay hub. Loaded per-session
// via the agent's MCP config. Identity + hub URL come from env (RELAY_SESSION, RELAY_URL).
// Loading this server AUTO-REGISTERS the session — so presence works on every agent.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir, hostname } from "node:os";
import { execSync } from "node:child_process";
import { z } from "zod";

function relayUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL;
  try {
    const cfg = join(homedir(), ".agent-bus", "config.json");
    if (existsSync(cfg)) { const u = JSON.parse(readFileSync(cfg, "utf8")).url; if (u) return u; }
  } catch {}
  return "http://127.0.0.1:4477";
}
const URL_BASE = relayUrl();
const SESSION = process.env.RELAY_SESSION || `${hostname()}:${basename(process.env.CLAUDE_PROJECT_DIR || process.cwd())}`;
let cursor = 0;

async function api(method, path, payload) {
  const opts = { method, headers: { "content-type": "application/json" } };
  if (payload) opts.body = JSON.stringify(payload);
  const r = await fetch(URL_BASE + path, opts);
  if (!r.ok) throw new Error(`hub ${r.status} on ${path}`);
  return r.json();
}
const fmt = (m) => `#${m.id} [${m.from} -> ${m.to}] ${new Date(m.ts).toLocaleTimeString()}: ${m.text}`;

const server = new McpServer({ name: "agent-bus", version: "0.1.0" });

server.tool("relay_whoami", "Show this session's relay identity and the hub URL.", {}, async () => {
  await api("POST", "/register", { session: SESSION }).catch(() => {});
  return { content: [{ type: "text", text: `session=${SESSION}\nhub=${URL_BASE}` }] };
});

server.tool("relay_peers", "List other Claude sessions connected to the relay (online in last 5 min).", {}, async () => {
  const { peers } = await api("GET", "/peers");
  const lines = peers.map(p => `${p.online ? "🟢" : "⚪"} ${p.session}${p.session === SESSION ? " (you)" : ""}`);
  return { content: [{ type: "text", text: lines.join("\n") || "no peers yet" }] };
});

server.tool("relay_send", "Send a live message to another Claude session (or 'all' to broadcast).",
  { to: z.string().describe("target session id, or 'all'"), text: z.string().describe("message body") },
  async ({ to, text }) => {
    const { id } = await api("POST", "/send", { from: SESSION, to, text });
    return { content: [{ type: "text", text: `sent #${id} to ${to}` }] };
  });

server.tool("relay_status", "Set this session's one-line status on the presence board (what you're working on / idle). Cheap — other sessions read it instantly via relay_peers without messaging you.",
  { status: z.string().describe("short status, e.g. 'building auth in crebral' or 'idle'") },
  async ({ status }) => {
    await api("POST", "/status", { session: SESSION, status });
    return { content: [{ type: "text", text: `status set: ${status}` }] };
  });

server.tool("relay_handoff", "Write a rich handoff for THIS session so a fresh session (any agent) can take over with a full context window instead of compacting. Provide a complete markdown summary (TASK / STATE / KEY DECISIONS / NEXT STEPS / KEY FILES). Universal — works in any agent, not just Claude's PreCompact hook.",
  { summary: z.string().describe("complete markdown handoff: TASK, STATE, KEY DECISIONS, NEXT STEPS, KEY FILES & locations") },
  async ({ summary }) => {
    const project = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const name = basename(project);
    const dir = join(homedir(), ".agent-bus", "handoffs");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const stamp = (() => { try { return execSync("date +%s", { encoding: "utf8" }).trim(); } catch { return String(process.pid); } })();
    let git = ""; try { git = execSync("git -C " + JSON.stringify(project) + " status --short 2>/dev/null | head -30", { encoding: "utf8" }).trim(); } catch {}
    const rec = { id: `${name}-${stamp}`, project, projectName: name, machine: hostname(), trigger: "relay_handoff-tool", stamp: Number(stamp) || 0, summary: String(summary), gitStatus: git, consumed: false };
    writeFileSync(join(dir, `${rec.id}.json`), JSON.stringify(rec, null, 2));
    await api("POST", "/send", { from: SESSION, to: "all", text: `📋 Handoff ready for ${name} — open a fresh session here to take over (${rec.id}).` }).catch(() => {});
    return { content: [{ type: "text", text: `handoff saved (${rec.id}). A fresh session in ${name} will load it on start. Tell the user to open a new terminal here.` }] };
  });

server.tool("relay_inbox", "Read NEW messages addressed to this session since the last read (non-blocking).", {}, async () => {
  const { messages, cursor: c } = await api("GET", `/inbox?session=${encodeURIComponent(SESSION)}&since=${cursor}`);
  cursor = c;
  return { content: [{ type: "text", text: messages.length ? messages.map(fmt).join("\n") : "(no new messages)" }] };
});

server.tool("relay_wait", "Block up to `timeout` seconds waiting for the next message to this session (long-poll). Returns the instant a message arrives. When idle, park on a long wait (e.g. 280) for instant, near-free wake-up.",
  { timeout: z.number().optional().describe("seconds to wait, default 25, max 280 (use a high value to idle-park for an instant wake)") },
  async ({ timeout }) => {
    const w = Math.min(timeout ?? 25, 280);
    const { messages, cursor: c } = await api("GET", `/poll?session=${encodeURIComponent(SESSION)}&since=${cursor}&wait=${w}`);
    cursor = c;
    return { content: [{ type: "text", text: messages.length ? messages.map(fmt).join("\n") : "(timed out, no message)" }] };
  });

await api("POST", "/register", { session: SESSION }).catch(() => {});
await server.connect(new StdioServerTransport());
process.stderr.write(`[agent-bus-mcp] connected as ${SESSION} -> ${URL_BASE}\n`);

#!/usr/bin/env node
// claude-relay MCP server — gives a Claude Code session tools to talk to OTHER
// live Claude sessions through the relay hub. Loaded per-session via --mcp-config
// or `claude mcp add`. Identity + hub URL come from env (RELAY_SESSION, RELAY_URL).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const URL_BASE = process.env.RELAY_URL || "http://127.0.0.1:4477";
const SESSION = process.env.RELAY_SESSION || `sess-${process.pid}`;
let cursor = 0;

async function api(method, path, payload) {
  const opts = { method, headers: { "content-type": "application/json" } };
  if (payload) opts.body = JSON.stringify(payload);
  const r = await fetch(URL_BASE + path, opts);
  if (!r.ok) throw new Error(`hub ${r.status} on ${path}`);
  return r.json();
}
const fmt = (m) => `#${m.id} [${m.from} -> ${m.to}] ${new Date(m.ts).toLocaleTimeString()}: ${m.text}`;

const server = new McpServer({ name: "claude-relay", version: "0.1.0" });

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

server.tool("relay_inbox", "Read NEW messages addressed to this session since the last read (non-blocking).", {}, async () => {
  const { messages, cursor: c } = await api("GET", `/inbox?session=${encodeURIComponent(SESSION)}&since=${cursor}`);
  cursor = c;
  return { content: [{ type: "text", text: messages.length ? messages.map(fmt).join("\n") : "(no new messages)" }] };
});

server.tool("relay_wait", "Block up to `timeout` seconds waiting for the next message to this session (long-poll).",
  { timeout: z.number().optional().describe("seconds to wait, default 25, max 55") },
  async ({ timeout }) => {
    const w = Math.min(timeout ?? 25, 55);
    const { messages, cursor: c } = await api("GET", `/poll?session=${encodeURIComponent(SESSION)}&since=${cursor}&wait=${w}`);
    cursor = c;
    return { content: [{ type: "text", text: messages.length ? messages.map(fmt).join("\n") : "(timed out, no message)" }] };
  });

await api("POST", "/register", { session: SESSION }).catch(() => {});
await server.connect(new StdioServerTransport());
process.stderr.write(`[claude-relay-mcp] connected as ${SESSION} -> ${URL_BASE}\n`);

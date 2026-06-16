#!/usr/bin/env node
// trantor MCP server — gives ANY MCP-capable agent (Claude Code, Codex, Gemini, …)
// tools to talk to OTHER live agent sessions through the relay hub. Loaded per-session
// via the agent's MCP config. Identity + hub URL come from env (RELAY_SESSION, RELAY_URL).
// Loading this server AUTO-REGISTERS the session — so presence works on every agent.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir, hostname } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { advise } from "./bin/advise.mjs";
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
const PROJECT = process.env.RELAY_PROJECT || basename(process.env.CLAUDE_PROJECT_DIR || process.cwd());
// Identity: RELAY_SESSION wins; else RELAY_AGENT ("codex", "kimi", …) brands the session per-project
// (set it once in the CLI's global MCP config — works in every project); else hostname:project.
const SESSION = process.env.RELAY_SESSION
  || (process.env.RELAY_AGENT ? `${process.env.RELAY_AGENT}:${PROJECT}` : `${hostname()}:${PROJECT}`);
let cursor = 0;

async function api(method, path, payload) {
  const opts = { method, headers: { "content-type": "application/json" } };
  if (payload) opts.body = JSON.stringify(payload);
  const r = await fetch(URL_BASE + path, opts);
  if (!r.ok) throw new Error(`hub ${r.status} on ${path}`);
  return r.json();
}
const fmt = (m) => `#${m.id} [${m.from} -> ${m.to}] ${new Date(m.ts).toLocaleTimeString()}: ${m.text}`;

const server = new McpServer({ name: "trantor", version: "0.1.0" });

server.tool("relay_whoami", "Show this session's relay identity, project, and the hub URL.", {}, async () => {
  await api("POST", "/register", { session: SESSION, project: PROJECT }).catch(() => {});
  return { content: [{ type: "text", text: `session=${SESSION}\nproject=${PROJECT}\nhub=${URL_BASE}` }] };
});

server.tool("relay_task_add", "Add a Kanban card to THIS project's board on the dashboard (what you're about to work on). Defaults: assigned to you, status 'todo'. Keep the team's progress visible.",
  { title: z.string().describe("short task title"), status: z.enum(["todo","doing","testing","failed","done","blocked"]).optional(), assignee: z.string().optional().describe("session id to assign (default: you)"), difficulty: z.enum(["easy","medium","hard"]).optional().describe("difficulty tag — drives model/agent routing (relay_advise) and shows on the board"), model: z.string().optional().describe("the model this card is routed to (from relay_advise routing, or the CLI default) — shown on the card"), deps: z.array(z.number()).optional().describe("card ids this card depends on — drawn as edges in the Flow view (e.g. integration depends on every crew card)") },
  async ({ title, status, assignee, difficulty, model, deps }) => {
    const { task } = await api("POST", "/task", { project: PROJECT, title, status: status || "todo", assignee: assignee || SESSION, difficulty, model, deps, by: SESSION });
    return { content: [{ type: "text", text: `card #${task.id} added to ${PROJECT}: "${title}" [${task.status}]` }] };
  });

server.tool("relay_task_move", "Move a Kanban card as you progress: todo -> doing -> testing -> done. NEVER move straight to done: move to 'testing' when you finish, run the project's tests/typecheck, then 'done' only if green — or 'failed' (with a relay_send explaining what broke) if not. The orchestrator bounces failed cards back to doing. blocked = waiting on something external.",
  { id: z.number(), status: z.enum(["todo","doing","testing","failed","done","blocked"]) },
  async ({ id, status }) => {
    await api("POST", "/task/update", { id, status, by: SESSION });
    return { content: [{ type: "text", text: `card #${id} -> ${status}` }] };
  });

server.tool("relay_project_brief", "Set a one-paragraph brief for THIS project shown on the dashboard: what it is, why it matters, and the goal. Set it once when you start work so anyone watching the board understands the project at a glance (the board itself shows where it is in the process).",
  { brief: z.string().describe("1-3 sentences: what this project is + why + the goal") },
  async ({ brief }) => {
    await api("POST", "/project", { project: PROJECT, brief, by: SESSION });
    return { content: [{ type: "text", text: `brief set for ${PROJECT}` }] };
  });

server.tool("relay_advise", "THE ADVISOR — ask the brain how to execute a body of work before spending tokens. Give it your work packages (with difficulty); it weighs task shape x the user's plan economics x context horizon and returns: mode (solo|scrooge|crew|hybrid), per-package executor+model routing, and a real-money estimate with quota-pool accounting. Call this at project kickoff and PRESENT the summary to the user before firing anything up.",
  { task: z.string().describe("one-line description of the overall job"),
    packages: z.array(z.object({ title: z.string(), difficulty: z.enum(["easy","medium","hard"]).optional(), kind: z.string().optional() })).describe("the work packages you'd cut as cards"),
    horizon: z.enum(["short","medium","long"]).optional().describe("how long this build will run (default inferred from package count)") },
  async ({ task, packages, horizon }) => {
    const out = advise({ task, packages, horizon });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

server.tool("relay_scrooge", "Delegate a SMALL, SELF-CONTAINED piece of grunt work (draft a function, summarize, extract, classify, boilerplate) to a cheap external model via Scrooge — costs a fraction of a cent and keeps the result OUT of expensive context where possible. Returns the model's output plus the ledger receipt. Use for stateless one-shots; use the crew for anything stateful or large.",
  { prompt: z.string().describe("the complete, self-contained task (include all needed context — the cheap model sees ONLY this)"),
    task: z.string().optional().describe("scrooge task type: code, summarize, extract, draft, verify, reason, cheap (default code)"),
    difficulty: z.enum(["easy","medium","hard"]).optional() },
  async ({ prompt, task, difficulty }) => {
    const r = spawnSync("scrooge", ["-t", task || "code", "-d", difficulty || "easy"], { input: prompt, encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    if (r.error || r.status !== 0) return { content: [{ type: "text", text: `scrooge failed: ${r.error?.message || r.stderr?.slice(-300) || "exit " + r.status}` }] };
    const receipt = (r.stderr || "").split("\n").filter(l => l.includes("\u{1FA99}") || l.includes("scrooge")).slice(-1)[0] || "";
    return { content: [{ type: "text", text: `${r.stdout.trim()}\n\n[receipt] ${receipt.trim()}` }] };
  });

server.tool("relay_lesson", "Record a LESSON learned from a failure so future crews avoid it — injected into agents' kickoff prompts automatically. Use when you diagnose a recurring or preventable failure. scope: 'global' (applies to every agent) or an agent brand ('kimi','codex','gemini','deepseek') when it's that CLI's quirk.",
  { text: z.string().describe("one-line imperative guardrail, e.g. 'never move a card to done without npm test passing'"), scope: z.string().optional().describe("'global' (default) or an agent brand") },
  async ({ text, scope }) => {
    const r = await api("POST", "/lesson", { text, scope: scope || "global", by: SESSION });
    return { content: [{ type: "text", text: r.dedup ? "lesson already recorded" : `lesson recorded (${r.count} total)` }] };
  });

server.tool("relay_board", "Show THIS project's Kanban board (all cards + their status + assignee).", {}, async () => {
  const { tasks } = await api("GET", `/tasks?project=${encodeURIComponent(PROJECT)}`);
  if (!tasks.length) return { content: [{ type: "text", text: `${PROJECT}: no cards yet` }] };
  const by = { todo: [], doing: [], testing: [], failed: [], done: [], blocked: [] };
  for (const t of tasks) (by[t.status] || by.todo).push(`#${t.id} ${t.title}${t.assignee ? ` (@${t.assignee})` : ""}`);
  const cols = Object.entries(by).filter(([, v]) => v.length).map(([k, v]) => `${k.toUpperCase()}:\n  ${v.join("\n  ")}`);
  return { content: [{ type: "text", text: `${PROJECT} board\n${cols.join("\n")}` }] };
});

server.tool("relay_peers", "List other Claude sessions connected to the relay (online in last 5 min).", {}, async () => {
  const { peers } = await api("GET", "/peers");
  const lines = peers.map(p => {
    // health surfaces a failing-but-alive agent (runner-reported) — not a green lie
    const icon = !p.online ? "⚪" : p.health === "down" ? "🛑" : p.health === "errored" ? "🔴" : "🟢";
    const note = (p.health === "errored" || p.health === "down") && p.status ? ` — ${p.status}` : "";
    return `${icon} ${p.session}${p.session === SESSION ? " (you)" : ""}${note}`;
  });
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
    await api("POST", "/status", { session: SESSION, status, project: PROJECT });
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

server.tool("relay_wait", "Block up to `timeout` seconds waiting for the next message to this session (long-poll). Returns the instant a message arrives. When idle, park by calling this repeatedly. IMPORTANT: some MCP clients cap tool calls (Codex ~120s, OpenCode ~60s) — use timeout 50 and loop, unless you know your client allows more (Claude Code handles 280).",
  { timeout: z.number().optional().describe("seconds to wait, default 25, max 280. Use 50 and call repeatedly for cross-client safety; only Claude Code reliably supports 280.") },
  async ({ timeout }) => {
    const w = Math.min(timeout ?? 25, 280);
    const { messages, cursor: c } = await api("GET", `/poll?session=${encodeURIComponent(SESSION)}&since=${cursor}&wait=${w}`);
    cursor = c;
    return { content: [{ type: "text", text: messages.length ? messages.map(fmt).join("\n") : "(timed out, no message)" }] };
  });

await api("POST", "/register", { session: SESSION, project: PROJECT, status: `active in ${PROJECT}` }).catch(() => {});

// Heartbeat — keep this session's presence fresh for as long as the MCP process lives.
// Registration alone decays after the hub's online window (5 min); without this, idle agents
// — and EVERY agent after the laptop sleeps (dead connection, no resume event) — fall off the
// board while their process is still alive. This is the UNIVERSAL counterpart to the Claude-only
// PostToolUse heartbeat hook: it runs inside the relay every agent loads (Claude, codex, gemini,
// kimi, deepseek), so the whole crew stays tracked. We POST /register with NO status, so the
// hub refreshes lastSeen but preserves the session's meaningful status. setInterval pauses during
// sleep and fires on wake, so presence self-heals within one interval; .unref() lets the process
// still exit cleanly when the agent closes the stdio transport (no phantom peers).
const HEARTBEAT_MS = Number(process.env.RELAY_HEARTBEAT_MS || 60 * 1000);
setInterval(() => { api("POST", "/register", { session: SESSION, project: PROJECT }).catch(() => {}); }, HEARTBEAT_MS).unref?.();

await server.connect(new StdioServerTransport());
process.stderr.write(`[trantor-mcp] connected as ${SESSION} -> ${URL_BASE} (heartbeat ${HEARTBEAT_MS}ms)\n`);

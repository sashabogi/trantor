#!/usr/bin/env node
// trantor MCP server — gives ANY MCP-capable agent (Claude Code, Codex, Gemini, …)
// tools to talk to OTHER live agent sessions through the relay hub. Loaded per-session
// via the agent's MCP config. Identity + hub URL come from env (RELAY_SESSION, RELAY_URL).
// Loading this server AUTO-REGISTERS the session — so presence works on every agent.
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir, hostname } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { advise } from "./bin/advise.mjs";
import { resolveProject, hostId, resolveHub } from "./lib/project.mjs";
import { signedPost, signedGet } from "./hooks/lib/api.mjs";
import { assertNoSecrets } from "./lib/scrub.mjs";

// ---- runtime dep resolution -------------------------------------------------
// `claude plugin install` snapshots the REPO, not an npm tarball, so a GitHub-sourced
// plugin ships no node_modules — and a static `import "@modelcontextprotocol/sdk/..."`
// then dies with ERR_MODULE_NOT_FOUND before a single line runs. The failure is silent
// from the user's side: every relay tool just disappears. So resolve these two ourselves.
// Normal path is untouched (plain `import(spec)`, ESM build, deps present); only when that
// comes back NOT_FOUND do we borrow the tree from the globally installed `trantor`, which
// npm always gives real dependencies at the same version as the plugin.
const HERE = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);

let fallbackRoots = null;
function borrowRoots() {
  if (fallbackRoots) return fallbackRoots;
  const roots = [];
  const add = (p) => { if (p && !roots.includes(p)) roots.push(p); };
  // Cheap guesses first — every one of these is a string join, no process spawn.
  if (process.env.npm_config_prefix) add(join(process.env.npm_config_prefix, "lib", "node_modules"));
  add(join(dirname(process.execPath), "..", "lib", "node_modules"));   // homebrew, nvm, volta, asdf
  // Only shell out if the guesses missed — `npm root -g` costs ~0.5s of MCP startup.
  if (!roots.some((r) => existsSync(join(r, "trantor")))) {
    try { add(execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); } catch {}
  }
  fallbackRoots = roots.flatMap((r) => [join(r, "trantor"), r]);
  return fallbackRoots;
}

async function dep(spec) {
  try {
    return await import(spec);
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND" && err?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw err;
  }
  for (const path of [HERE, ...borrowRoots()]) {
    try { return await import(pathToFileURL(req.resolve(spec, { paths: [path] })).href); } catch {}
  }
  throw new Error(
    `[trantor-mcp] cannot resolve '${spec}'. This plugin snapshot has no node_modules and no global ` +
    `trantor install was found to borrow from. Fix: npm i -g trantor  (or: cd ${HERE} && npm install --omit=dev)`,
  );
}

const { McpServer } = await dep("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = await dep("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = await dep("zod");

// Stable project key: RELAY_PROJECT > git-repo-root basename > cwd basename. Keying by
// the git root (not a loose cwd basename) stops one repo fragmenting into several lanes.
const PROJECT = resolveProject(process.env.CLAUDE_PROJECT_DIR || process.cwd());
// Hub URL is PER-PROJECT (TDD §12.1): RELAY_URL env → config.json hubs[PROJECT] → legacy
// global `url` → local default. A project lives on exactly one hub; codependent projects
// must share one, so both are pinned to the same hub via `trantor hub set`.
const URL_BASE = resolveHub(PROJECT);   // boot-time snapshot: startup log only — every api() call re-resolves
// Identity: RELAY_SESSION wins; else RELAY_AGENT ("codex", "kimi", …) brands the session per-project
// (set it once in the CLI's global MCP config — works in every project); else hostname:project.
const SESSION = process.env.RELAY_SESSION
  || (process.env.RELAY_AGENT ? `${process.env.RELAY_AGENT}:${PROJECT}` : `${hostId()}:${PROJECT}`);
let cursor = 0;
// First-call guard: a brand-new MCP process must NOT replay the entire historical backlog (observed:
// 2,379 msgs / 520KB back to an old asteroids project) the instant relay_inbox/relay_wait is called.
// Seed the cursor to the current max deliverable id once, exactly like hooks/inbox-deliver.mjs does on
// its first run. The seed uses a non-peek /inbox so the hub's shared delivery ledger advances too —
// telling stop-inbox "this session is caught up to now", so a fresh session isn't blocked on backlog it
// was never meant to act on. After the seed, the model starts listening "from now".
let cursorSeeded = false;
async function seedCursor() {
  if (cursorSeeded) return;
  cursorSeeded = true;
  try {
    const r = await api("GET", `/inbox?session=${encodeURIComponent(SESSION)}&since=0`);
    cursor = r?.cursor || 0;
  } catch { /* hub down: the subsequent real call surfaces the error; leave cursor at 0 */ }
}

// Every hub call is SIGNED with this session's Ed25519 keypair (TDD §7.3) via the shared client in
// hooks/lib/api.mjs. Writes: that is what binds /send's `from` to the signer and closes the
// self-asserted `from` hole (the 2026-07-28 RCE). Reads TOO (the 2026-07-30 agent-UX gap): an
// enforce hub 401s unsigned reads, which made relay_inbox/board/peers dead for the very agents the
// bus exists for. Signed reads are scope-filtered by the hub to this identity's grants — for a
// session reading its own project + DMs that is the intended behavior. The client fail-opens on a
// down hub (returns {ok:false}); we surface that as a thrown Error so individual tools .catch it.
// Instance id (docs/INSTANCE-KEYS-CONTRACT.md): the MCP server has no harness session_id, so it
// mints a random id at boot — its lifetime ≈ the session's. The endorsed subkey it keys signs all
// traffic; the durable identity keeps enrollment and attribution.
const INSTANCE_ID = `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
async function api(method, path, payload) {
  const r = method.toUpperCase() === "GET"
    ? await signedGet(path, { session: SESSION, instance: INSTANCE_ID })
    : await signedPost(path, payload, { session: SESSION, instance: INSTANCE_ID });
  if (!r.ok) throw new Error(`hub ${r.status} on ${path}`);
  return r.json;
}
const fmt = (m) => `#${m.id} [${m.from} -> ${m.to}] ${new Date(m.ts).toLocaleTimeString()}: ${m.text}`;

const server = new McpServer({ name: "trantor", version: "0.1.0" });

server.tool("relay_whoami", "Show this session's relay identity, project, and the hub URL.", {}, async () => {
  await api("POST", "/register", { session: SESSION, project: PROJECT }).catch(() => {});
  return { content: [{ type: "text", text: `session=${SESSION}\nproject=${PROJECT}\nhub=${resolveHub(PROJECT)}` }] };
});

server.tool("relay_task_add", "Add a Kanban card to a project's board on the dashboard (what you're about to work on). Defaults: THIS project, assigned to you, status 'todo'. Pass `project` to target another board — e.g. when you orchestrate a crew that runs in a different directory than the one you launched Claude from. Keep the team's progress visible.",
  { title: z.string().describe("short task title"), status: z.enum(["todo","doing","testing","failed","done","blocked"]).optional(), assignee: z.string().optional().describe("session id to assign (default: you)"), difficulty: z.enum(["easy","medium","hard"]).optional().describe("difficulty tag — drives model/agent routing (relay_advise) and shows on the board"), model: z.string().optional().describe("the model this card is routed to (from relay_advise routing, or the CLI default) — shown on the card"), deps: z.array(z.number()).optional().describe("card ids this card depends on — drawn as branch edges in the Flow view (e.g. integration depends on every crew card)"), phase: z.string().optional().describe("phase/milestone this card belongs to (e.g. 'P5', 'Auth', 'Launch') — groups it in the Flow view's phase flowchart. Optional; otherwise inferred from the title prefix + time."), project: z.string().optional().describe("board to add to (default: this session's project). Set to the crew's project when you orchestrate from a different directory") },
  async ({ title, status, assignee, difficulty, model, deps, phase, project }) => {
    const proj = project || PROJECT;
    const { task } = await api("POST", "/task", { project: proj, title, status: status || "todo", assignee: assignee || SESSION, difficulty, model, deps, phase, by: SESSION });
    return { content: [{ type: "text", text: `card #${task.id} added to ${proj}: "${title}" [${task.status}]${phase?` · phase ${phase}`:""}` }] };
  });

server.tool("relay_phase_goal", "Set what a PHASE is for — its goal — shown as the phase header in the Flow view (overrides the theme auto-derived from card titles). Capture this when you plan a phase so the board says what each milestone needs to do, not just 'P5'. Phase keys match relay_task_add's `phase` (or the inferred title-prefix family like 'P5').",
  { phase: z.string().describe("the phase key (e.g. 'P5', 'Auth', 'Launch')"), goal: z.string().describe("1-2 sentences: what this phase delivers + done-criteria"), project: z.string().optional().describe("board (default: this session's project)") },
  async ({ phase, goal, project }) => {
    const proj = project || PROJECT;
    await api("POST", "/phase", { project: proj, phase, goal, by: SESSION });
    return { content: [{ type: "text", text: `phase "${phase}" goal set for ${proj}` }] };
  });

server.tool("relay_task_move", "Move a Kanban card as you progress: todo -> doing -> testing -> done. NEVER move straight to done: move to 'testing' when you finish, run the project's tests/typecheck, then 'done' only if green — or 'failed' (with a relay_send explaining what broke) if not. The orchestrator bounces failed cards back to doing. blocked = waiting on something external.",
  { id: z.number(), status: z.enum(["todo","doing","testing","failed","done","blocked"]) },
  async ({ id, status }) => {
    await api("POST", "/task/update", { id, status, by: SESSION });
    return { content: [{ type: "text", text: `card #${id} -> ${status}` }] };
  });

server.tool("relay_project_brief", "Set a one-paragraph brief for a project shown on the dashboard: what it is, why it matters, and the goal. Defaults to THIS project; pass `project` to brief a crew board you orchestrate from elsewhere. Set it once when you start work so anyone watching the board understands the project at a glance (the board itself shows where it is in the process).",
  { brief: z.string().describe("1-3 sentences: what this project is + why + the goal"), project: z.string().optional().describe("board to brief (default: this session's project)") },
  async ({ brief, project }) => {
    const proj = project || PROJECT;
    await api("POST", "/project", { project: proj, brief, by: SESSION });
    return { content: [{ type: "text", text: `brief set for ${proj}` }] };
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

server.tool("relay_verify_gate", "Record a VERIFICATION GATE — a claim that MUST be independently verified before the related work ships (e.g. 'Gail breast coefficients match the published BCRAT model'). Unlike a note buried in a handoff narrative, a gate is STRUCTURED: it travels with handoffs and is shown PROMINENTLY to whoever takes over, so a safety-critical 'verify before commit' can't be skimmed past. action 'add' when you produce code whose correctness you have NOT independently proven (especially formulas/coefficients/security/data-shape); 'resolve' once you've verified it (or waived with the user); 'list' to see open gates. Defaults to THIS project.",
  { action: z.enum(["add", "resolve", "list"]).describe("add a gate · resolve one · list open gates"),
    claim: z.string().optional().describe("what must be verified (required for add) — a specific, checkable claim"),
    why: z.string().optional().describe("why it matters / the risk if it ships unverified"),
    howToVerify: z.string().optional().describe("the concrete check that would verify it (source to cross-check, command to run)"),
    id: z.number().optional().describe("gate id to resolve"),
    status: z.string().optional().describe("resolve status: 'verified' (default) | 'failed' | 'waived'"),
    note: z.string().optional().describe("resolution note (what you checked / why waived)"),
    project: z.string().optional().describe("target project (default: this session's project)") },
  async ({ action, claim, why, howToVerify, id, status, note, project }) => {
    const proj = project || PROJECT;
    if (action === "list") {
      const { gates } = await api("GET", `/verify-gates?project=${encodeURIComponent(proj)}`);
      if (!gates || !gates.length) return { content: [{ type: "text", text: `${proj}: no open verification gates` }] };
      return { content: [{ type: "text", text: gates.map(g => `#${g.id} ⚠️ ${g.claim}${g.why ? ` — ${g.why}` : ""}`).join("\n") }] };
    }
    if (action === "resolve") {
      if (!id) return { content: [{ type: "text", text: "id required to resolve a gate" }] };
      const r = await api("POST", "/verify-gate", { resolve: true, id, status: status || "verified", note, project: proj, by: SESSION });
      return { content: [{ type: "text", text: r.error ? `error: ${r.error}` : `gate #${id} resolved (${r.gate?.status || status || "verified"})` }] };
    }
    if (!claim) return { content: [{ type: "text", text: "claim required to add a gate" }] };
    const r = await api("POST", "/verify-gate", { claim, why, howToVerify, project: proj, by: SESSION });
    return { content: [{ type: "text", text: r.dedup ? `gate already open (#${r.gate.id})` : `🔒 verification gate #${r.gate.id} recorded — surfaces on every handoff until you resolve it` }] };
  });

server.tool("relay_board", "Show a project's Kanban board (all cards + their status + assignee). Defaults to THIS project; pass `project` to read a crew board you orchestrate from elsewhere.",
  { project: z.string().optional().describe("board to show (default: this session's project)") },
  async ({ project }) => {
  const proj = project || PROJECT;
  const { tasks } = await api("GET", `/tasks?project=${encodeURIComponent(proj)}`);
  if (!tasks.length) return { content: [{ type: "text", text: `${proj}: no cards yet` }] };
  const by = { todo: [], doing: [], testing: [], failed: [], done: [], blocked: [] };
  for (const t of tasks) (by[t.status] || by.todo).push(`#${t.id} ${t.title}${t.assignee ? ` (@${t.assignee})` : ""}`);
  const cols = Object.entries(by).filter(([, v]) => v.length).map(([k, v]) => `${k.toUpperCase()}:\n  ${v.join("\n  ")}`);
  return { content: [{ type: "text", text: `${proj} board\n${cols.join("\n")}` }] };
});

server.tool("relay_peers", "Find who you can talk to: the live agent sessions on the relay (online in last 5 min), including sessions in projects linked to yours. Call this BEFORE concluding you have no way to reach someone — the session ids it returns are what relay_send takes.", {}, async () => {
  const { peers } = await api("GET", "/peers");
  const lines = peers.map(p => {
    // health surfaces a failing-but-alive agent (runner-reported) — not a green lie
    const icon = !p.online ? "⚪" : p.health === "down" ? "🛑" : p.health === "errored" ? "🔴" : "🟢";
    const note = (p.health === "errored" || p.health === "down") && p.status ? ` — ${p.status}` : "";
    return `${icon} ${p.session}${p.session === SESSION ? " (you)" : ""}${note}`;
  });
  return { content: [{ type: "text", text: lines.join("\n") || "no peers yet" }] };
});

server.tool("relay_send", "Send a live message to another agent session (or 'all' to broadcast). Reach the other agent YOURSELF: if you are about to ask the human to pass something along, tell the session directly instead — asking a person to carry a message between two agents is a failure, not politeness. Don't know the id? relay_peers lists them, linked projects included. Cross-project sends are allowed.",
  { to: z.string().describe("target session id, or 'all'"), text: z.string().describe("message body") },
  async ({ to, text }) => {
    // The event log is append-only — a secret in it is unrecoverable, so refuse BEFORE
    // anything reaches the hub. Returns the offending kinds so the caller can fix it.
    const scrub = assertNoSecrets(text);
    if (!scrub.ok) {
      return { content: [{ type: "text", text: `REFUSED — not sent. Credential-shaped string(s) detected: ${scrub.kinds.join(", ")}. Remove them and resend.` }], isError: true };
    }
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
  await seedCursor();
  const { messages, cursor: c } = await api("GET", `/inbox?session=${encodeURIComponent(SESSION)}&since=${cursor}`);
  cursor = c;
  return { content: [{ type: "text", text: messages.length ? messages.map(fmt).join("\n") : "(no new messages)" }] };
});

server.tool("relay_wait", "Block up to `timeout` seconds waiting for the next message to this session (long-poll). Returns the instant a message arrives. When idle, park by calling this repeatedly. IMPORTANT: MCP clients cap or background long tool calls — OpenCode ~60s; Codex ~120s; Claude Code auto-backgrounds ANY MCP call at 120s (CC 2.1.212+, tunable via CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS), which breaks inline parking. Use timeout 50 and loop for cross-client safety.",
  { timeout: z.number().optional().describe("seconds to wait, default 25. Effective wait is capped at 110s so the call always returns inline (a longer wait would be auto-backgrounded by Claude Code's 120s MCP floor or dropped by other clients). Use 50 and call repeatedly to park while idle.") },
  async ({ timeout }) => {
    // Cap below the 120s MCP auto-background floor (CC 2.1.212+) so relay_wait always
    // resolves inline on every current client instead of being shipped to the background.
    const w = Math.min(timeout ?? 25, 110);
    await seedCursor();
    const { messages, cursor: c } = await api("GET", `/poll?session=${encodeURIComponent(SESSION)}&since=${cursor}&wait=${w}`);
    cursor = c;
    return { content: [{ type: "text", text: messages.length ? messages.map(fmt).join("\n") : "(timed out, no message)" }] };
  });

const HEARTBEAT_MS = Number(process.env.RELAY_HEARTBEAT_MS || 60 * 1000);

// Mirror the SessionStart/PostToolUse hooks: a session opened in the home directory itself
// isn't project work — auto-registering it would spawn a phantom "<username>" project board.
// Opt in explicitly with RELAY_SESSION or RELAY_PROJECT. The MCP server still starts so the
// user can call relay tools (e.g. relay_whoami) deliberately; we just skip auto-presence.
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const isHomeDirSession = !process.env.RELAY_SESSION && !process.env.RELAY_PROJECT && projectDir === homedir();

if (!isHomeDirSession) {
  await api("POST", "/register", { session: SESSION, project: PROJECT, status: `active in ${PROJECT}` })
    .catch((err) => { process.stderr.write(`[trantor-mcp] initial register failed: ${err?.message || err}\n`); });

  // Heartbeat — keep this session's presence fresh for as long as the MCP process lives.
  // Registration alone decays after the hub's online window (5 min); without this, idle agents
  // — and EVERY agent after the laptop sleeps (dead connection, no resume event) — fall off the
  // board while their process is still alive. This is the UNIVERSAL counterpart to the Claude-only
  // PostToolUse heartbeat hook: it runs inside the relay every agent loads (Claude, codex, gemini,
  // kimi, deepseek), so the whole crew stays tracked. We POST /register with NO status, so the
  // hub refreshes lastSeen but preserves the session's meaningful status. setInterval pauses during
  // sleep and fires on wake, so presence self-heals within one interval; .unref() lets the process
  // still exit cleanly when the agent closes the stdio transport (no phantom peers).
  setInterval(() => { api("POST", "/register", { session: SESSION, project: PROJECT }).catch(() => {}); }, HEARTBEAT_MS).unref?.();
} else {
  process.stderr.write("[trantor-mcp] home directory — not auto-registering on the bus (set RELAY_SESSION or RELAY_PROJECT to opt in)\n");
}

await server.connect(new StdioServerTransport());
process.stderr.write(`[trantor-mcp] connected as ${SESSION} -> ${URL_BASE}${isHomeDirSession ? " (no auto-presence: home dir)" : ` (heartbeat ${HEARTBEAT_MS}ms)`}\n`);

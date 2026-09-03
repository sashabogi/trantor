#!/usr/bin/env node
// trantor MCP server — gives ANY MCP-capable agent (Claude Code, Codex, Gemini, …)
// tools to talk to OTHER live agent sessions through the relay hub. Loaded per-session
// via the agent's MCP config. Identity + hub URL come from env (RELAY_SESSION, RELAY_URL).
// Loading this server AUTO-REGISTERS the session — so presence works on every agent.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir, hostname } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { advise } from "./bin/advise.mjs";
import { resolveProject, hostId, resolveHub, resolveHubInfo, nonSeatReason, handoffDir, orchWriterSid } from "./lib/project.mjs";
import { signedPost, signedGet } from "./hooks/lib/api.mjs";
import { anchorCursor } from "./hooks/lib/inbox-ledger.mjs";
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
// Identity: the runner's exact RELAY_SESSION wins, then its RELAY_AGENT. A multi-seat host such as
// OpenCode contributes only RELAY_AGENT_FALLBACK in its global MCP config, so qwen/glm/deepseek do
// not get rebranded "opencode" when that config is overlaid on the runner environment.
const SESSION_AGENT = process.env.RELAY_AGENT || process.env.RELAY_AGENT_FALLBACK;
const SESSION = process.env.RELAY_SESSION
  || (SESSION_AGENT ? `${SESSION_AGENT}:${PROJECT}` : `${hostId()}:${PROJECT}`);
let cursor = 0;
// First-call guard: a brand-new MCP process must NOT replay the entire historical backlog (observed:
// 2,379 msgs / 520KB back to an old asteroids project) the instant relay_inbox/relay_wait is called.
// The seed anchors to BOOT (this server starts with the session), never to the time of the first call:
// seeding to "now at first call" swallowed #7282 on 2026-08-20 — the call came 33 minutes into the
// session, prompted by a nudge ABOUT that message. PEEK only: the hooks own the hub's delivery ledger
// (sessionstart claims the pre-start backlog); a non-peek seed here marked unseen messages delivered.
const BOOT_TS = Date.now();
let cursorSeeded = false;
async function seedCursor() {
  if (cursorSeeded) return;
  try {
    const r = await api("GET", `/inbox?session=${encodeURIComponent(SESSION)}&since=0&peek=1`);
    cursor = anchorCursor(r?.messages, BOOT_TS);
    cursorSeeded = true;
  } catch { /* hub down: the subsequent real call surfaces the error; retry the seed next time */ }
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
async function api(method, path, payload, { timeoutMs } = {}) {
  // PROJECT explicitly, never the client's cwd fallback: this server's project is fixed at boot,
  // and letting the hub be re-derived per call is how a session ends up writing to two hubs.
  const r = method.toUpperCase() === "GET"
    ? await signedGet(path, { session: SESSION, instance: INSTANCE_ID, project: PROJECT, timeoutMs })
    : await signedPost(path, payload, { session: SESSION, instance: INSTANCE_ID, project: PROJECT, timeoutMs });
  if (!r.ok) throw new Error(`hub ${r.status} on ${path}`);
  return r.json;
}
const fmt = (m) => `#${m.id} [${m.from} -> ${m.to}] ${new Date(m.ts).toLocaleTimeString()}: ${m.text}`;

const server = new McpServer({ name: "trantor", version: "0.1.0" });

server.tool("relay_whoami", "Show this session's relay identity, project, hub URL, HOW that hub was chosen, and whether this session is actually a registered seat.", {}, async () => {
  // This tool used to POST /register before answering — so asking "where am I?" from a
  // non-project directory CREATED the phantom seat it then reported, on the local hub, and the
  // answer looked healthy. A diagnostic must observe, never mutate. It now reports the truth,
  // including the two things that actually go wrong: an unregistered session, and a hub that was
  // a fallback rather than a pin.
  const { url, via } = resolveHubInfo(PROJECT);
  const viaText = { env: "RELAY_URL env override", pin: "pinned for this project", global: "GLOBAL DEFAULT — this project is not pinned", default: "BUILT-IN DEFAULT — no config found" }[via] || via;
  let text = `session=${SESSION}\nproject=${PROJECT}\nhub=${url}\nhub_via=${via} (${viaText})\nregistered=${isHomeDirSession ? "NO" : "yes"}`;
  if (isHomeDirSession) {
    text += `\n\n⚠️ This session is NOT a seat — its directory is ${nonProjectReason}, so it never registered.`
      + ` relay_peers will look empty and relay_send reaches nobody. That is NOT the bus being down.`
      + ` Fix it by running Claude from the project directory (cd <project> && claude).`;
  }
  if (via === "global" || via === "default") {
    text += `\n\n⚠️ "${PROJECT}" has no hub pin, so ${url} is a fallback, not a routing decision.`
      + ` If the crew is pinned elsewhere this seat cannot see them. Check \`trantor hub list\`;`
      + ` pin with \`trantor hub set ${PROJECT} <url>\`.`;
  }
  return { content: [{ type: "text", text }] };
});

server.tool("relay_contracts", "What you dispatched and are still owed. Lists every DIRECT message you sent to another session, with how long it has been outstanding, whether that session is still alive, and its last known status. Each one carries a disposition: WAITING (assignee alive and working — normal), STALLED (assignee offline or overdue — poke it, swap it, or reassign), ABANDONED (assignee gone so long the contract can never be answered — the work needs reassigning, nobody is coming back), SUPERSEDED (the assignee is alive and has since answered a NEWER contract from you, so this row was never going to be answered — no action needed), or answered, with the outcome text. Call this before concluding a crew is idle, stuck, or done — silence on the bus is not evidence either way.", {},
  async () => {
    let r;
    try { r = await api("GET", `/contracts?session=${encodeURIComponent(SESSION)}&project=${encodeURIComponent(PROJECT)}`); }
    catch (e) { return { content: [{ type: "text", text: `could not reach the hub: ${e?.message || e}` }] }; }
    // The hub keeps abandoned contracts in their own key so older stop hooks stop blocking on them.
    // The ledger still wants to SHOW them, so put the two halves back together here.
    const all = [...(r?.contracts || []), ...(r?.abandonedContracts || []), ...(r?.supersededContracts || [])]
      .sort((a, b) => a.ts - b.ts);
    if (!all.length) return { content: [{ type: "text", text: "You have not dispatched any contracts in the last 24h." }] };
    // Fall back to the pre-disposition shape when talking to an older hub.
    const disp = (c) => c.disposition || (c.answered ? "answered" : (c.assigneeOnline ? "waiting" : "stalled"));
    const open = all.filter(c => disp(c) === "waiting" || disp(c) === "stalled");
    const abandoned = all.filter(c => disp(c) === "abandoned");
    const superseded = all.filter(c => disp(c) === "superseded");
    const mins = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)}m` : `${Math.round(ms / 1000)}s`);
    const MARK = { answered: "✅", waiting: "⏳", stalled: "⚠️", abandoned: "🪦", superseded: "⤳" };
    const line = (c) => {
      const d = disp(c);
      const health = d === "answered" ? "" :
        c.assigneeOnline ? ` · alive (${c.assigneeStatus || "no status"})`
        : c.assigneeLastSeenMs == null ? " · NEVER SEEN on the bus"
        : ` · LAST SEEN ${mins(c.assigneeLastSeenMs)} ago`;
      const out = d === "answered" ? ` → ${String(c.answer?.text || "").slice(0, 120)}` : "";
      const tag = d === "answered" ? "" : ` [${d.toUpperCase()}]`;
      return `${MARK[d] || "⏳"} #${c.id} → ${c.to} (${mins(c.ageMs)} ago)${tag}${health}: "${String(c.text).slice(0, 100)}"${out}`;
    };
    const notes = [];
    if (open.some(c => disp(c) === "stalled")) {
      notes.push("⚠️ A STALLED contract's assignee is offline or overdue. Waiting will not finish the work — check it, swap it (`trantor swap <agent>`), or reassign.");
    }
    if (abandoned.length) {
      notes.push(`🪦 ${abandoned.length} ABANDONED: the assignee has been gone too long for these to ever be answered. Nobody is coming back — reassign the work or drop it deliberately.`);
    }
    if (superseded.length) {
      notes.push(`⤳ ${superseded.length} SUPERSEDED: the assignee is alive and has since answered a newer contract from you, so these were never going to be answered. Nothing is owed — do not chase them.`);
    }
    const text = `${open.length} outstanding of ${all.length} contract(s) in the last 24h`
      + (abandoned.length ? ` (plus ${abandoned.length} abandoned)` : "")
      + (superseded.length ? ` (plus ${superseded.length} superseded)` : "") + `:\n`
      + all.slice(-25).map(line).join("\n")
      + (notes.length ? "\n\n" + notes.join("\n") : "");
    return { content: [{ type: "text", text }] };
  });

server.tool("relay_task_add", "Add a Kanban card to a project's board on the dashboard (what you're about to work on). Defaults: THIS project, assigned to you, status 'todo'. Pass `project` to target another board — e.g. when you orchestrate a crew that runs in a different directory than the one you launched Claude from. Keep the team's progress visible. Attach a `note` whenever context isn't obvious from the title — it lands on the card's permanent log ({ts,by,text}, kept: last 40).",
  { title: z.string().describe("short task title"), status: z.enum(["todo","doing","testing","failed","done","blocked"]).optional(), assignee: z.string().optional().describe("session id to assign (default: you)"), difficulty: z.enum(["easy","medium","hard"]).optional().describe("difficulty tag — drives model/agent routing (relay_advise) and shows on the board"), model: z.string().optional().describe("the model this card is routed to (from relay_advise routing, or the CLI default) — shown on the card"), deps: z.array(z.number()).optional().describe("card ids this card depends on — drawn as branch edges in the Flow view (e.g. integration depends on every crew card)"), phase: z.string().optional().describe("phase/milestone this card belongs to (e.g. 'P5', 'Auth', 'Launch') — groups it in the Flow view's phase flowchart. Optional; otherwise inferred from the title prefix + time."), note: z.string().max(2000).optional().describe("optional card-log entry (<=2000 chars): context, the plan, or a link — stored on the card as {ts,by,text}"), project: z.string().optional().describe("board to add to (default: this session's project). Set to the crew's project when you orchestrate from a different directory"), checklist: z.array(z.string().max(200)).max(20).optional().describe("acceptance items for the card — the honest denominator for its progress bar. Tick them off with relay_task_check as each is truly met") },
  async ({ title, status, assignee, difficulty, model, deps, phase, note, project, checklist }) => {
    const proj = project || PROJECT;
    const { task } = await api("POST", "/task", { project: proj, title, status: status || "todo", assignee: assignee || SESSION, difficulty, model, deps, phase, note, checklist, by: SESSION });
    return { content: [{ type: "text", text: `card #${task.id} added to ${proj}: "${title}" [${task.status}]${phase?` · phase ${phase}`:""}${task.checklist?.length?` · ${task.checklist.length} acceptance item(s)`:""}` }] };
  });

server.tool("relay_task_check", "Tick (or untick) ONE acceptance item on a card's checklist — the card's progress bar reads checked/total, so tick an item only when it is genuinely met (tests run, behavior observed), never to make the bar move. Items are 0-indexed in the order relay_task_add listed them.",
  { id: z.number().describe("card id"), index: z.number().int().min(0).describe("0-based checklist item index"), done: z.boolean().optional().describe("default true; pass false to untick") },
  async ({ id, index, done }) => {
    const { task } = await api("POST", "/task/checklist-toggle", { id, index, done: done !== false, by: SESSION });
    const n = task.checklist.filter(c => c.done).length;
    return { content: [{ type: "text", text: `card #${id} checklist: [${done !== false ? "x" : " "}] "${task.checklist[index].text}" — ${n}/${task.checklist.length} done` }] };
  });

server.tool("relay_phase_goal", "Set what a PHASE is for — its goal — shown as the phase header in the Flow view (overrides the theme auto-derived from card titles). Capture this when you plan a phase so the board says what each milestone needs to do, not just 'P5'. Phase keys match relay_task_add's `phase` (or the inferred title-prefix family like 'P5').",
  { phase: z.string().describe("the phase key (e.g. 'P5', 'Auth', 'Launch')"), goal: z.string().describe("1-2 sentences: what this phase delivers + done-criteria"), project: z.string().optional().describe("board (default: this session's project)") },
  async ({ phase, goal, project }) => {
    const proj = project || PROJECT;
    await api("POST", "/phase", { project: proj, phase, goal, by: SESSION });
    return { content: [{ type: "text", text: `phase "${phase}" goal set for ${proj}` }] };
  });

server.tool("relay_task_move", "Move a Kanban card as you progress: todo -> doing -> testing -> done. NEVER move straight to done: move to 'testing' when you finish, run the project's tests/typecheck, then 'done' only if green — or 'failed' (with a relay_send explaining what broke) if not. The orchestrator bounces failed cards back to doing. blocked = waiting on something external. A move to 'testing' or 'done' MUST carry a `note` (<=2000 chars): what you changed and the evidence (the test command + counts). The note lands on the card's permanent log — the board shows its ·N count, so a silent move reads as unverified work.",
  { id: z.number(), status: z.enum(["todo","doing","testing","failed","done","blocked"]), note: z.string().max(2000).optional().describe("card-log entry (<=2000 chars) — REQUIRED on moves to testing/done: what changed + the evidence (command, pass counts)") },
  async ({ id, status, note }) => {
    await api("POST", "/task/update", { id, status, note, by: SESSION });
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

server.tool("relay_propose", "PROPOSE a standing permission or scope change to the human operator — the ONLY approver; nothing auto-approves. A proposal must state its BOUND: scope (what), condition (when it applies), exclusions (what is still NOT covered) — a permission without a bound is a blank cheque and is rejected. It sits pending (max 3 per session — withdraw one to file another) until the operator decides in the app or CLI; you get a bus message with the decision. Denials are REMEMBERED: a near-duplicate of a denied proposal is refused, so never re-propose — refine the bound or move on. File it and continue your mission; never nag.",
  { scope: z.string().describe("WHAT standing permission you want, specific and checkable — e.g. 'push directly to main in this repo'"),
    condition: z.string().describe("WHEN it applies — e.g. 'only after the full test suite exits 0'"),
    exclusions: z.string().describe("what is still NOT covered — e.g. 'never force-push, never touch release tags'"),
    key: z.string().optional().describe("optional machine-readable capability slug (e.g. 'patrol.reap-orphans') — lets tools check the grant exactly instead of matching prose"),
    project: z.string().optional().describe("project the permission concerns (default: this session's project)") },
  async ({ scope, condition, exclusions, key, project }) => {
    // signedPost directly (not api()) — a refusal's BODY is the teaching moment (denial note,
    // queue guidance) and api() throws it away, leaving only "hub 409".
    const r = await signedPost("/propose", { session: SESSION, project: project || PROJECT, scope, condition, exclusions, key }, { session: SESSION, instance: INSTANCE_ID });
    if (!r.ok) {
      const j = r.json || {};
      const extra = j.note ? ` The operator's note on the prior denial: "${j.note}".` : "";
      return { content: [{ type: "text", text: `REFUSED: ${j.error || `hub ${r.status}`}.${extra}` }], isError: true };
    }
    const pr = r.json.proposal;
    return { content: [{ type: "text", text: r.json.dedup
      ? `already pending as proposal #${pr.id} — the operator has it; do not re-file`
      : `proposal #${pr.id} filed and PENDING operator review. Continue your mission — you'll get a bus message when it's decided. Do NOT act as if it were approved.` }] };
  });

server.tool("relay_proposals", "List THIS session's permission proposals and their statuses (pending / approved / denied / revoked / withdrawn), including the operator's decision notes. An APPROVED proposal is a standing GRANT — act within its stated bound without re-asking. Check here before relying on a permission you proposed — pending is not approved.", {},
  async () => {
    const { proposals } = await api("GET", `/proposals?session=${encodeURIComponent(SESSION)}`);
    if (!proposals?.length) return { content: [{ type: "text", text: "no proposals filed by this session" }] };
    const icon = { pending: "⏳", approved: "✅", denied: "⛔", withdrawn: "↩️", revoked: "🚫" };
    const lines = proposals.map(p =>
      `#${p.id} ${icon[p.status] || ""} ${p.status.toUpperCase()} — ${p.scope} · when: ${p.condition} · NOT covered: ${p.exclusions}${p.note ? ` · operator: "${p.note}"` : ""}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });

server.tool("relay_withdraw_proposal", "Withdraw one of THIS session's PENDING permission proposals (frees a queue slot — the pending queue caps at 3 per session).",
  { id: z.number().describe("proposal id to withdraw (yours, pending only)") },
  async ({ id }) => {
    const r = await signedPost("/proposal/withdraw", { id, session: SESSION }, { session: SESSION, instance: INSTANCE_ID });
    if (!r.ok) return { content: [{ type: "text", text: `could not withdraw: ${r.json?.error || `hub ${r.status}`}` }], isError: true };
    return { content: [{ type: "text", text: `proposal #${id} withdrawn — one queue slot free` }] };
  });

// ONE card, not the board (#6134). A seat used to be told to "query the board for related PAST
// cards and lessons — 1900+ cards of tribal knowledge", and it did: the whole board, every turn,
// almost all of it other people's work. This is the same intent at a thousandth of the tokens —
// the card, what it waits on, its own notes, and the handful of done cards that actually rhyme
// with it. Client-side on /tasks, so no hub change and it works against any hub version.
const STOPWORDS = new Set(["the","a","an","and","or","of","to","in","on","for","with","is","it","its","that","this","not","but","by","at","as","from","into","out","up","down","when","then","than","so","no","new","one","two","every","all","any"]);
function titleWords(title) {
  return new Set(String(title || "").toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g)?.filter(w => !STOPWORDS.has(w)) || []);
}
function cardView(tasks, id, proj) {
  const card = tasks.find(t => t.id === id);
  if (!card) return `${proj}: no card #${id}`;
  const out = [`#${card.id} ${card.title}`,
    `status: ${card.status}${card.assignee ? ` · @${card.assignee}` : ""}${card.difficulty ? ` · ${card.difficulty}` : ""}${card.model ? ` · ${card.model}` : ""}`];

  const deps = (Array.isArray(card.deps) ? card.deps : []).map(d => {
    const t = tasks.find(x => x.id === d);
    return t ? `#${t.id} ${t.title} [${t.status}]` : `#${d} (not on this board)`;
  });
  if (deps.length) out.push(`depends on:\n  ${deps.join("\n  ")}`);

  if (Array.isArray(card.checklist) && card.checklist.length) {
    out.push(`checklist:\n  ${card.checklist.map((c, i) => `[${c.done ? "x" : " "}] ${i}. ${c.text || c}`).join("\n  ")}`);
  }

  const log = Array.isArray(card.log) ? card.log : [];
  if (log.length) out.push(`notes (${log.length}):\n  ${log.map(e => `${e.by || "?"}: ${String(e.text || "").replace(/\s+/g, " ")}`).join("\n  ")}`);

  // The prior art that is actually prior art: done cards whose title shares a real word with this
  // one. Five, newest first — enough to catch "we already did this", short enough to stay cheap.
  const mine = titleWords(card.title);
  const kin = tasks
    .filter(t => t.status === "done" && t.id !== card.id && [...titleWords(t.title)].some(w => mine.has(w)))
    .sort((a, b) => (b.updated || b.ts || 0) - (a.updated || a.ts || 0))
    .slice(0, 5)
    .map(t => `#${t.id} ${t.title}${t.log?.length ? ` ·${t.log.length}` : ""}`);
  if (kin.length) out.push(`related done cards:\n  ${kin.join("\n  ")}`);

  return out.join("\n");
}

server.tool("relay_board", "Show a project's Kanban board (all cards + their status + assignee). Defaults to THIS project; pass `project` to read a crew board you orchestrate from elsewhere. Cards carrying log notes show a ·N count (the card's note-log size).",
  { project: z.string().optional().describe("board to show (default: this session's project)"),
    card: z.number().optional().describe("read ONE card instead of the board: the card itself, its notes, and the last five done cards whose title shares a word with it. This is what a seat starting a card should call — the whole board is 1900+ cards of someone else's work.") },
  async ({ project, card }) => {
  const proj = project || PROJECT;
  const { tasks } = await api("GET", `/tasks?project=${encodeURIComponent(proj)}`);
  if (!tasks.length) return { content: [{ type: "text", text: `${proj}: no cards yet` }] };
  if (card) return { content: [{ type: "text", text: cardView(tasks, card, proj) }] };
  const by = { todo: [], doing: [], testing: [], failed: [], done: [], blocked: [] };
  for (const t of tasks) (by[t.status] || by.todo).push(`#${t.id} ${t.title}${t.assignee ? ` (@${t.assignee})` : ""}${t.log?.length ? ` ·${t.log.length}` : ""}`);
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
  { to: z.string().describe("target session id, or 'all'"), text: z.string().describe("message body"),
    wake: z.boolean().optional().describe("false = context, not a contract: the message batches into the target's next turn instead of buying it a whole CLI session. Use it for acks, FYIs and queue notes; leave it unset for anything you expect worked on.") },
  async ({ to, text, wake }) => {
    // The event log is append-only — a secret in it is unrecoverable, so refuse BEFORE
    // anything reaches the hub. Returns the offending kinds so the caller can fix it.
    const scrub = assertNoSecrets(text);
    if (!scrub.ok) {
      return { content: [{ type: "text", text: `REFUSED — not sent. Credential-shaped string(s) detected: ${scrub.kinds.join(", ")}. Remove them and resend.` }], isError: true };
    }
    const { id } = await api("POST", "/send", { from: SESSION, to, text, ...(wake === false ? { wake: false } : {}) });
    return { content: [{ type: "text", text: `sent #${id} to ${to}${wake === false ? " (batched — no turn)" : ""}` }] };
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
    const dir = handoffDir();   // the SHARED resolver — a hardcoded homedir here diverged from the reader once already (handoff.mjs:21)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const stamp = (() => { try { return execSync("date +%s", { encoding: "utf8" }).trim(); } catch { return String(process.pid); } })();
    let git = ""; try { git = execSync("git -C " + JSON.stringify(project) + " status --short 2>/dev/null | head -30", { encoding: "utf8" }).trim(); } catch {}
    // session_id: WHO wrote this. This server has no harness session id, so it records the orch
    // thread's id when the evidence says the writer IS that thread (orchWriterSid). Without it a
    // tool-written orchestrator handoff carries no writer and the baton-hold + map-follow logic in
    // sessionstart.mjs can never fire (found live 2026-08-28: trantor-1787886998 had session_id null).
    const rec = { id: `${name}-${stamp}`, project, projectName: name, machine: hostname(), trigger: "relay_handoff-tool", session_id: orchWriterSid(project, PROJECT), stamp: Number(stamp) || 0, summary: String(summary), gitStatus: git, consumed: false };
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
    // The client-side deadline must OUTLIVE the hub's hold. Since reads moved onto the shared
    // signed client, this call inherited its 1.5s default — so every long-poll that had no message
    // already waiting was aborted at 1.5s and surfaced as "hub 0 on /poll". Parking was dead: the
    // tool erred on every quiet wait and only ever "worked" when a message beat the abort.
    const { messages, cursor: c } = await api("GET", `/poll?session=${encodeURIComponent(SESSION)}&since=${cursor}&wait=${w}`, undefined, { timeoutMs: (w + 15) * 1000 });
    cursor = c;
    return { content: [{ type: "text", text: messages.length ? messages.map(fmt).join("\n") : "(timed out, no message)" }] };
  });

const HEARTBEAT_MS = Number(process.env.RELAY_HEARTBEAT_MS || 60 * 1000);

// This server's own plugin version, stamped on every /register. Only the tool-use heartbeat HOOK
// used to write hookVersion, so a fresh-but-idle session's peer row kept its DEAD predecessor's
// version until the first tool call — misread twice on 2026-08-19 as "wrong plugin version after
// restart". The MCP boots with the session and registers immediately, so it makes the row truthful
// from second one. Same lookup as hooks/lib/update-check.mjs: plugin.json beside this file, then
// package.json (running straight from the repo).
const MCP_VERSION = (() => {
  for (const rel of ["./.claude-plugin/plugin.json", "./package.json"]) {
    try {
      const v = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")).version;
      if (v) return v;
    } catch {}
  }
  return "";
})();

// Mirror the SessionStart/PostToolUse hooks: some directories aren't project work, and
// auto-registering from them spawns a phantom project lane that then sits in the sidebar forever.
// PROJECT falls back to the cwd basename, so the directory name becomes the lane name:
//   - the home directory itself      → a "<username>" lane
//   - a plugin-cache snapshot        → a lane named after the VERSION, e.g. "0.17.66"
// The second one is not hypothetical: `cd ~/.claude/plugins/cache/trantor/trantor/<ver> &&
// node mcp.mjs` is the documented way to check the relay server still boots after a plugin
// update, and every such check was leaving a version-numbered lane behind.
// Opt in explicitly with RELAY_SESSION or RELAY_PROJECT. The MCP server still starts so the
// user can call relay tools (e.g. relay_whoami) deliberately; we just skip auto-presence.
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
// ONE definition of "is this a seat", shared with the SessionStart hook (lib/project.mjs). When
// the hook and this server disagreed, a session in a non-repo directory got the hook's "not a
// seat" verdict AND an MCP registration — a phantom peer on the fallback hub, which is the
// split-brain the whole fix exists to remove. nonSeatReason() also covers a plain non-git
// directory (~/development), the case the old home-dir-only check let through.
const nonProjectReason = nonSeatReason(projectDir);
const isHomeDirSession = !!nonProjectReason;

// #6170: WHAT this session is, when it can know. sessionstart stamps kind "orch" on the
// orchestrator pane, but that runs once — every MCP beat afterwards was kindless, and the hub's
// crew exemption reads the peer row's kind, so the orchestrator kept being demoted by its own
// heartbeat and then warned about as an intruder on its own project. Same test sessionstart uses:
// TRANTOR_ORCH names the project this pane orchestrates.
const KIND = process.env.TRANTOR_ORCH && process.env.TRANTOR_ORCH === PROJECT ? { kind: "orch" } : {};

if (!isHomeDirSession) {
  await api("POST", "/register", { session: SESSION, project: PROJECT, status: `active in ${PROJECT}`, hookVersion: MCP_VERSION, ...KIND })
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
  setInterval(() => { api("POST", "/register", { session: SESSION, project: PROJECT, hookVersion: MCP_VERSION, ...KIND }).catch(() => {}); }, HEARTBEAT_MS).unref?.();
} else {
  process.stderr.write(`[trantor-mcp] ${nonProjectReason} — not auto-registering on the bus (set RELAY_SESSION or RELAY_PROJECT to opt in)\n`);
}

await server.connect(new StdioServerTransport());
process.stderr.write(`[trantor-mcp] connected as ${SESSION} -> ${URL_BASE}${isHomeDirSession ? ` (no auto-presence: ${nonProjectReason})` : ` (heartbeat ${HEARTBEAT_MS}ms)`}\n`);

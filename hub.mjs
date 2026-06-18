#!/usr/bin/env node
// trantor hub — message bus + presence/status board + SSE push, so independent
// Claude Code sessions can coordinate (near-instant for watchers, cheap for idle peers).
// Binds to LOOPBACK (127.0.0.1) by default — local-first and safe (no auth yet). To let other
// machines reach it (e.g. over a Tailscale tailnet), set RELAY_HOST=0.0.0.0 — but only on a
// private network, or add auth first. See "Always-on / remote hub" in the README (roadmap).
import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.RELAY_PORT || 4477);
const HOST = process.env.RELAY_HOST || "127.0.0.1";
const DATA_DIR = process.env.RELAY_DATA_DIR || join(homedir(), ".agent-bus");
const DATA = join(DATA_DIR, "bus.json");
const ONLINE_MS = Number(process.env.RELAY_ONLINE_MS || 5 * 60 * 1000);
const PEER_TTL_DEFAULT_MS = 21600000; // 6h
const _peerTtlRaw = Number(process.env.RELAY_PEER_TTL_MS || PEER_TTL_DEFAULT_MS);
const PEER_TTL_MS = Math.max(Number.isFinite(_peerTtlRaw) ? _peerTtlRaw : PEER_TTL_DEFAULT_MS, ONLINE_MS);
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// Scrooge ledger cache: /economics is polled every ~15s by the dashboard, but the ledger
// (~/.token-scrooge/calls.jsonl) only changes when a cheap-model call lands. Re-parse the whole
// file only when its mtime moves; otherwise reuse the parsed rows. Keeps the lifetime running
// total cheap to serve no matter how big the ledger grows.
let _ledgerCache = { mtimeMs: -1, rows: [] };

// Per-turn failure telemetry lives across many ~/.agent-bus/logs/<agent>-<project>.jsonl files
// (written by crew-runner.mjs). Scanning them all every /learning poll would be wasteful, so cache
// the aggregate and only rescan when a log file changes (tracked by the dir's newest mtime).
const LOGDIR = join(homedir(), ".agent-bus", "logs");
let _telemetryCache = { maxMtimeMs: -1, turns: [] };
function scanTelemetry() {
  let files = [];
  try { files = readdirSync(LOGDIR).filter(f => f.endsWith(".jsonl")); } catch { return _telemetryCache.turns; }
  let maxMtime = 0;
  for (const f of files) { try { const m = statSync(join(LOGDIR, f)).mtimeMs; if (m > maxMtime) maxMtime = m; } catch {} }
  if (maxMtime === _telemetryCache.maxMtimeMs) return _telemetryCache.turns;   // nothing changed
  const turns = [];
  for (const f of files) {
    let txt = ""; try { txt = readFileSync(join(LOGDIR, f), "utf8"); } catch { continue; }
    for (const line of txt.trim().split("\n")) {
      if (!line) continue;
      try { const r = JSON.parse(line); if (r && r.agent) turns.push(r); } catch {}
    }
  }
  _telemetryCache = { maxMtimeMs: maxMtime, turns };
  return turns;
}

// peers: { session: { lastSeen, status, project } } ; tasks: kanban cards
// projectMeta: { project: { brief, by, updated } } — the "what & why" blurb per project
let state = { messages: [], peers: {}, seq: 0, tasks: [], taskSeq: 0, projectMeta: {}, lessons: [], cardEvents: [], cardEventsBackfilled: false, aliases: {}, phaseMeta: {} };
try {
  if (existsSync(DATA)) {
    const loaded = JSON.parse(readFileSync(DATA, "utf8"));
    state = { messages: loaded.messages || [], peers: {}, seq: loaded.seq || 0, tasks: loaded.tasks || [], taskSeq: loaded.taskSeq || 0, projectMeta: loaded.projectMeta || {}, lessons: loaded.lessons || [], cardEvents: Array.isArray(loaded.cardEvents) ? loaded.cardEvents : [], cardEventsBackfilled: !!loaded.cardEventsBackfilled, aliases: (loaded.aliases && typeof loaded.aliases === "object") ? loaded.aliases : {}, phaseMeta: (loaded.phaseMeta && typeof loaded.phaseMeta === "object") ? loaded.phaseMeta : {} };
    for (const [s, v] of Object.entries(loaded.peers || {})) // migrate old numeric form
      state.peers[s] = typeof v === "number" ? { lastSeen: v, status: "", project: "" } : { lastSeen: v.lastSeen || 0, status: v.status || "", project: v.project || "" };
  }
} catch {}
let dirty = false;
const persist = () => { if (dirty) { try { writeFileSync(DATA, JSON.stringify(state)); dirty = false; } catch {} } };
setInterval(persist, 1000).unref?.();
// One-time backfill: reconstruct the cardEvents history log from each card's authoritative per-card
// `history` trail, so projects that existed BEFORE the cardEvents log show their FULL past in the
// TIMELINE view (not just events from now on). Guarded by a flag so it runs once where cardEvents
// persists; in team mode cardEvents is in-memory, so this re-derives from the persisted task.history
// on every boot — which is exactly right.
function backfillCardEvents() {
  if (state.cardEventsBackfilled && state.cardEvents.length) return;
  const events = [];
  for (const t of (state.tasks || [])) for (const h of (t.history || [])) {
    events.push({ ts: h.ts || 0, type: h.from ? "moved" : "created", taskId: t.id, project: t.project,
      title: t.title, from: h.from || null, to: h.to || null, by: h.by || "",
      difficulty: t.difficulty || null, assignee: t.assignee || null });
  }
  if (events.length) {
    events.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    if (events.length > 5000) events.splice(0, events.length - 5000);
    events.forEach((e, i) => { e.id = i + 1; });
    state.cardEvents = events; dirty = true;
  }
  state.cardEventsBackfilled = true; dirty = true;
}
backfillCardEvents();
function prunePeers() {
  const cutoff = now() - PEER_TTL_MS;
  let removed = false;
  for (const [session, peer] of Object.entries(state.peers)) {
    if ((peer.lastSeen || 0) < cutoff) { delete state.peers[session]; removed = true; }
  }
  if (removed) dirty = true;
}
setInterval(prunePeers, 60000).unref?.();

// dashboard HTML (read once at startup)
let UI = "";
try { UI = readFileSync(new URL("./ui.html", import.meta.url), "utf8"); } catch {}

// open SSE streams: [{ session, res }]
const streams = [];
const now = () => Date.now();
const fmtAge = ms => { const m = Math.floor(ms / 60000); return m > 48 * 60 ? `${Math.floor(m / 1440)}d ago` : m > 90 ? `${Math.floor(m / 60)}h ago` : `${m}m ago`; };
function body(req) { return new Promise(r => { let d = ""; req.on("data", c => (d += c)); req.on("end", () => { try { r(d ? JSON.parse(d) : {}); } catch { r({}); } }); }); }
function json(res, code, obj) { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(obj)); }
// Canonical project name: follow the alias chain so historically-divergent keys
// (e.g. "builtbetter" → "builtbetter.ai") fold into one lane on every read AND
// write. Cycle-guarded. Empty/"all" pass through untouched.
function canon(name) {
  let n = String(name || "").slice(0, 80);
  const seen = new Set();
  while (n && state.aliases[n] && !seen.has(n)) { seen.add(n); n = state.aliases[n]; }
  return n;
}
function touch(session, status, project) {
  if (!session || session === "all") return;   // "all" is a wildcard, not a real peer
  const p = state.peers[session] || { lastSeen: 0, status: "", project: "" };
  p.lastSeen = now();
  if (status !== undefined) p.status = String(status).slice(0, 280);
  if (project) p.project = canon(String(project).slice(0, 80));
  // derive project from a "host:project" session id if none given
  if (!p.project && session.includes(":")) p.project = canon(session.split(":").pop().slice(0, 80));
  state.peers[session] = p; dirty = true;
}
// Derive a coarse health from the free-text status the runner sets on a failed turn
// ("errored: <reason>" / "down: <reason>") — lets the board show a failing-but-alive agent
// distinctly instead of a healthy green. Default "ok".
function healthOf(status) {
  const s = String(status || "").toLowerCase();
  if (s.startsWith("down")) return "down";
  if (s.startsWith("errored")) return "errored";
  return "ok";
}
function deliverable(m, session) { return (m.to === session || m.to === "all") && m.from !== session; }
function pushToStreams(msg) {
  for (const s of streams) if (deliverable(msg, s.session)) { try { s.res.write(`data: ${JSON.stringify(msg)}\n\n`); } catch {} }
}
function appendCardEvent(type, task, by, from = null, to = null) {
  const last = state.cardEvents[state.cardEvents.length - 1];
  state.cardEvents.push({
    id: (last?.id || 0) + 1,
    ts: now(),
    type,
    taskId: task.id,
    project: task.project,
    title: task.title,
    from,
    to,
    by: by || "",
    difficulty: task.difficulty || null,
    assignee: task.assignee || null,
  });
  if (state.cardEvents.length > 5000) state.cardEvents.splice(0, state.cardEvents.length - 5000);
}

// --- FLOW v2: derive a project's PHASES (the orchestrator-rooted flowchart spine) ---
// Real data is deps-sparse (most cards carry no deps), so we DON'T derive phases from the
// dependency graph. Instead: a card's phase = its title-prefix family (P5a/P5b → "P5",
// CBv2-1/CBfix → "CB", FA-comp1 → "FA", …) when present; otherwise it's clustered with its
// time-neighbours into a "Setup N" round (gap > 8h opens a new round). Phases are ordered by
// first-seen. The orchestrator (host session, "machine:project") vs crew ("brand:project")
// split gives each phase its fan-out actors; the plan/integrate spine nodes are synthetic
// because real per-phase orchestrator cards are rare. `sparse` flags a board that's mostly
// un-prefixed (the UI shows an "inferred phases" notice — never a silent blob).
const PHASE_GAP_MS = 8 * 60 * 60 * 1000;
const agentBrand = (a) => { const s = String(a || ""); const i = s.indexOf(":"); return i > 0 ? s.slice(0, i) : (s || ""); };
// Crew = a known helper-CLI brand; anything else with a brand (a machine hostname like
// "MacBook-Pro-M1.local" or "MacBookPro.hsd1.fl.comcast.net", or a generic "host") is the
// orchestrator. Brand-based (not hostname-pattern) so it's robust to hostname instability.
const CREW_BRANDS = /^(codex|gemini|kimi|deepseek|claude|qwen|grok|glm|mistral|llama)$/i;
const isOrchAssignee = (a) => { const b = agentBrand(a); return !!b && !CREW_BRANDS.test(b); };
function phaseFamily(title) {
  const s = String(title || "").trim();
  // "P5a Structured…", "P4-construction", "P3 Quantity" → P5/P4/P3 (group all P5a/b/c/d together).
  // The trailing letter and the separator must NOT be swallowed by \b (P5a has none between 5 and a).
  let m;
  if ((m = s.match(/^P(\d+)[a-z]?(?:[\s\-:.]|$)/i))) return "P" + m[1];
  if (/^CBv?\d/i.test(s) || /^CBfix/i.test(s) || /^CB[\s\-:.]/i.test(s)) return "CB";
  if (/^FA[\s\-:.\d]/i.test(s)) return "FA";
  if (/^RunCost/i.test(s)) return "RunCost";
  return null;
}
function phaseStatus(counts) {
  if (counts.failed) return "failed";
  if (counts.doing || counts.testing) return "active";
  const total = counts.todo + counts.doing + counts.testing + counts.failed + counts.done + counts.blocked;
  if (total > 0 && counts.done === total) return "done";
  if (counts.blocked) return "blocked";
  if (counts.todo === total) return "planned";
  return "active";
}
// A human "what is this phase about" line derived from the cards themselves: strip the phase-prefix
// token, take the subject before the first em/en-dash, dedupe, join the first few. Retroactive — no
// captured plan needed. An explicit phase goal (phaseMeta) overrides this in the /phases endpoint.
function phaseTheme(cards) {
  const subs = [];
  const seen = new Set();
  for (const c of cards) {
    let s = String(c.title || "")
      // drop the phase token INCLUDING any sub-index (P3.5, P5a, CBv2-1) + separators, so no "1"/".5" leaks
      .replace(/^\s*(P\d+[a-z]?(?:[.\-]\d+)?|CBv?\d+(?:[.\-]\d+)?|CBfix|FA[-\s:]?\w*|RunCost)[\s:\-–—#]*/i, "")
      .split(/[—–]| - /)[0].trim();                                                    // subject before a dash
    if (!s) continue;
    const k = s.toLowerCase().slice(0, 22);
    if (seen.has(k)) continue;
    seen.add(k); subs.push(s.slice(0, 48));
    if (subs.length >= 3) break;
  }
  return subs.join(" · ").slice(0, 120);
}
function derivePhases(tasks) {
  const sorted = [...tasks].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  let miscRound = 0, lastMiscTs = 0;
  for (const t of sorted) {
    // an explicit phase tag (set at plan time) wins; else infer from the title prefix; else time-cluster.
    const explicit = t.phase && String(t.phase).trim();
    const fam = explicit || phaseFamily(t.title);
    if (fam) { t._phase = fam; }
    else {
      if (!lastMiscTs || (t.ts || 0) - lastMiscTs > PHASE_GAP_MS) miscRound++;
      lastMiscTs = t.ts || lastMiscTs;
      t._phase = `Setup ${miscRound}`;
    }
  }
  const byPhase = new Map();
  for (const t of sorted) { if (!byPhase.has(t._phase)) byPhase.set(t._phase, []); byPhase.get(t._phase).push(t); }
  const phases = [...byPhase.entries()].map(([key, cards]) => {
    const counts = { todo:0, doing:0, testing:0, failed:0, done:0, blocked:0 };
    for (const c of cards) counts[c.status] = (counts[c.status] || 0) + 1;
    const node = (c) => ({ id: c.id, title: c.title, assignee: c.assignee || "", agent: agentBrand(c.assignee), model: c.model || "", status: c.status, difficulty: c.difficulty || "", ts: c.ts || 0, updated: c.updated || c.ts || 0, deps: Array.isArray(c.deps) ? c.deps : [] });
    const crew = cards.filter(c => !isOrchAssignee(c.assignee)).map(node);
    const orchestrators = cards.filter(c => isOrchAssignee(c.assignee)).map(node);
    return {
      key, label: key, theme: phaseTheme(cards),
      start: Math.min(...cards.map(c => c.ts || 0)), end: Math.max(...cards.map(c => c.updated || c.ts || 0)),
      counts, total: cards.length, status: phaseStatus(counts),
      agents: [...new Set(crew.map(c => c.agent).filter(Boolean))],
      crew, orchestrators,
    };
  }).sort((a, b) => a.start - b.start);
  const miscCount = sorted.filter(t => /^Setup /.test(t._phase)).length;
  return { phases, total: sorted.length, sparse: sorted.length > 0 && miscCount / sorted.length > 0.5, derivedBy: "title-prefix + time-cluster" };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"); const q = Object.fromEntries(u.searchParams); const P = u.pathname;
  try {
    if (req.method === "POST" && P === "/register") { const b = await body(req); touch(b.session, b.status, b.project); return json(res, 200, { ok: true, session: b.session, peers: Object.keys(state.peers) }); }
    if (req.method === "POST" && P === "/status") { const b = await body(req); touch(b.session, b.status ?? "", b.project); return json(res, 200, { ok: true }); }
    if (req.method === "GET" && P === "/peers") {
      prunePeers();
      const cutoff = now() - ONLINE_MS;
      return json(res, 200, { peers: Object.entries(state.peers).map(([s, v]) => ({ session: s, lastSeen: v.lastSeen, online: v.lastSeen > cutoff, status: v.status || "", health: healthOf(v.status), project: v.project || "" })) });
    }
    // --- Kanban tasks ---
    if (req.method === "POST" && P === "/task") {           // create a card
      const b = await body(req); touch(b.by, undefined, b.project);
      const st0 = ["todo","doing","testing","failed","done","blocked"].includes(b.status) ? b.status : "todo";
      // optional historical ts (backfill from git/import) — accept a past epoch-ms; else now().
      const ts0 = (Number.isFinite(b.ts) && b.ts > 0 && b.ts <= now() + 864e5) ? Math.floor(b.ts) : now();
      const t = { id: ++state.taskSeq, project: canon(String(b.project || "").slice(0,80)), title: String(b.title||"").slice(0,200),
        assignee: b.assignee || "", status: st0,
        phase: String(b.phase || "").slice(0, 40),   // explicit phase tag (FLOW v2) — wins over title-prefix inference
        source: String(b.source || "").slice(0, 20), // e.g. "git" (backfill), "todo" — provenance
        difficulty: ["easy","medium","hard"].includes(b.difficulty) ? b.difficulty : "",
        model: String(b.model || "").slice(0, 60),
        deps: Array.isArray(b.deps) ? [...new Set(b.deps.map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 20) : [],
        by: b.by || "", ts: ts0, updated: ts0,
        history: [{ to: st0, by: b.by || "", ts: ts0 }] };
      state.tasks.push(t); if (state.tasks.length > 2000) state.tasks.splice(0, 500);
      appendCardEvent("created", t, b.by, null, st0);
      dirty = true; return json(res, 200, { ok: true, task: t });
    }
    if (req.method === "POST" && P === "/task/update") {    // move/edit a card
      const b = await body(req); const t = state.tasks.find(x => x.id === Number(b.id));
      if (!t) return json(res, 404, { error: "no such task" });
      let eventType = "updated", eventFrom = null, eventTo = null;
      if (b.status && ["todo","doing","testing","failed","done","blocked"].includes(b.status) && b.status !== t.status) {
        eventType = "moved"; eventFrom = t.status; eventTo = b.status;
        (t.history ||= []).push({ from: t.status, to: b.status, by: b.by || "", ts: now() });
        if (t.history.length > 40) t.history.splice(0, 10);
        t.status = b.status;
      }
      if (b.difficulty && ["easy","medium","hard"].includes(b.difficulty)) t.difficulty = b.difficulty;
      if (b.model !== undefined) t.model = String(b.model).slice(0, 60);
      if (Array.isArray(b.deps)) t.deps = [...new Set(b.deps.map(Number).filter(n => Number.isInteger(n) && n > 0 && n !== t.id))].slice(0, 20);
      if (b.assignee !== undefined) t.assignee = b.assignee;
      if (b.title !== undefined) t.title = String(b.title).slice(0,200);
      if (b.delete) { eventType = "deleted"; eventFrom = null; eventTo = null; state.tasks = state.tasks.filter(x => x.id !== t.id); }
      appendCardEvent(eventType, t, b.by, eventFrom, eventTo);
      t.updated = now(); dirty = true; return json(res, 200, { ok: true, task: t });
    }
    // Mirror a session's TodoWrite list onto its board as cards, so SOLO work (no crew) shows up live
    // and accrues timeline history. pending/in_progress/completed -> todo/doing/done. Reconciled by
    // todo text per session: present todos create/update; a vanished todo's card is deleted UNLESS it
    // was already done (accomplished work stays in the DONE column). Posted by hooks/todo-sync.mjs.
    if (req.method === "POST" && P === "/todos") {
      const b = await body(req);
      const session = String(b.session || b.by || "").slice(0, 120);
      const project = canon(String(b.project || "").slice(0, 80));
      if (!session || !project) return json(res, 400, { error: "session and project required" });
      touch(session, undefined, project);
      const ST = { pending: "todo", in_progress: "doing", completed: "done" };
      const todos = Array.isArray(b.todos) ? b.todos : [];
      const mine = state.tasks.filter(t => t.source === "todo" && t.assignee === session && t.project === project);
      const seen = new Set();
      for (const todo of todos) {
        const key = String(todo?.content || "").trim().slice(0, 200);
        if (!key) continue;
        seen.add(key);
        const want = ST[todo.status] || "todo";
        let t = mine.find(c => c.todoKey === key);
        if (!t) {
          t = { id: ++state.taskSeq, project, title: key, assignee: session, status: want, difficulty: "", model: "",
            deps: [], by: session, ts: now(), updated: now(), source: "todo", todoKey: key,
            history: [{ to: want, by: session, ts: now() }] };
          state.tasks.push(t); appendCardEvent("created", t, session, null, want); dirty = true;
        } else if (t.status !== want) {
          (t.history ||= []).push({ from: t.status, to: want, by: session, ts: now() });
          if (t.history.length > 40) t.history.splice(0, 10);
          appendCardEvent("moved", t, session, t.status, want); t.status = want; t.updated = now(); dirty = true;
        }
      }
      for (const t of mine) {
        if (seen.has(t.todoKey) || t.status === "done") continue;   // keep accomplished work on the board
        state.tasks = state.tasks.filter(x => x.id !== t.id); appendCardEvent("deleted", t, session, null, null); dirty = true;
      }
      if (state.tasks.length > 2000) state.tasks.splice(0, state.tasks.length - 2000);
      return json(res, 200, { ok: true, count: todos.length });
    }
    if (req.method === "GET" && P === "/tasks") {
      const proj = q.project ? canon(q.project) : ""; const ts = proj ? state.tasks.filter(t => canon(t.project) === proj) : state.tasks;
      return json(res, 200, { tasks: ts });
    }
    if (req.method === "GET" && P === "/history") {
      const requestedLimit = Number(q.limit || 200);
      const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 200, 0), 1000);
      const proj = q.project ? canon(q.project) : "";
      const events = (proj ? state.cardEvents.filter(e => canon(e.project) === proj) : state.cardEvents).slice(-limit);
      return json(res, 200, { events });
    }
    // A single card's FULL story for the detail panel: the card itself, its status events, and the
    // bus messages that reference it (#<id>) — i.e. the agent's own reports of what it did, why, how.
    if (req.method === "GET" && P === "/card") {
      const id = Number(q.id);
      if (!Number.isInteger(id)) return json(res, 400, { error: "numeric id required" });
      const task = state.tasks.find(t => t.id === id) || null;
      const events = state.cardEvents.filter(e => e.taskId === id);
      const re = new RegExp("#" + id + "(?![0-9])");   // #5 but not #50
      const messages = state.messages.filter(m => re.test(String(m.text || ""))).slice(-200);
      // fall back to the last event for title/project/assignee when the card was deleted
      const last = events[events.length - 1];
      const meta = task || (last ? { id, title: last.title, project: last.project, status: "deleted", assignee: last.assignee, difficulty: last.difficulty } : null);
      return json(res, 200, { task: meta, events, messages });
    }
    if (req.method === "POST" && P === "/project") {        // set a project's brief (what & why)
      const b = await body(req); const k = canon(String(b.project || "").slice(0, 80));
      if (!k) return json(res, 400, { error: "project required" });
      const m = state.projectMeta[k] || {};
      if (b.brief !== undefined) m.brief = String(b.brief).slice(0, 600);
      m.by = b.by || m.by || ""; m.updated = now();
      state.projectMeta[k] = m; dirty = true;
      return json(res, 200, { ok: true, project: k, brief: m.brief || "" });
    }
    if (req.method === "POST" && P === "/project/delete") { // forget a project: its cards, peers, brief, and lane
      const b = await body(req); const k = String(b.project || "").slice(0, 80);
      if (!k) return json(res, 400, { error: "project required" });
      const nt = state.tasks.length, np = Object.keys(state.peers).length, nm = state.messages.length;
      state.tasks = state.tasks.filter(t => t.project !== k);
      for (const [s, v] of Object.entries(state.peers)) if (v.project === k) delete state.peers[s];
      delete state.projectMeta[k];
      state.messages = state.messages.filter(m2 => (m2.project || "") !== k);
      dirty = true;   // the project reappears cleanly if an agent ever registers it again
      return json(res, 200, { ok: true, project: k, removed: { tasks: nt - state.tasks.length, peers: np - Object.keys(state.peers).length, messages: nm - state.messages.length } });
    }
    // Fold one project lane into another: rewrite all stored project fields from→to AND
    // record an alias so future writes under `from` canonicalize to `to`. Idempotent.
    // This is how a fragmented project (one repo, two lane keys) becomes one continuous lane.
    if (req.method === "POST" && P === "/project/merge") {
      const b = await body(req);
      const from = String(b.from || "").slice(0, 80), to = String(b.to || "").slice(0, 80);
      if (!from || !to || from === to) return json(res, 400, { error: "distinct from+to required" });
      let cards = 0, events = 0, peers = 0, msgs = 0;
      for (const t of state.tasks) if (t.project === from) { t.project = to; cards++; }
      for (const e of state.cardEvents) if (e.project === from) { e.project = to; events++; }
      for (const v of Object.values(state.peers)) if (v.project === from) { v.project = to; peers++; }
      for (const m of state.messages) if ((m.project || "") === from) { m.project = to; msgs++; }
      if (state.projectMeta[from]) {
        if (!state.projectMeta[to]) state.projectMeta[to] = state.projectMeta[from];
        else if (!state.projectMeta[to].brief && state.projectMeta[from].brief) state.projectMeta[to].brief = state.projectMeta[from].brief;
        delete state.projectMeta[from];
      }
      state.aliases[from] = to;                       // future writes fold automatically
      for (const [k, v] of Object.entries(state.aliases)) if (v === from) state.aliases[k] = to; // re-point chains
      dirty = true;
      return json(res, 200, { ok: true, from, to, moved: { cards, events, peers, messages: msgs } });
    }
    // Catch-up snapshot: everything a NEW session needs to resume a project's continuous
    // lane — the brief, card counts, what's in-flight (doing/testing/todo) and the most
    // recent done work, plus last activity. Cheap + LLM-free; the SessionStart hook injects it.
    if (req.method === "GET" && P === "/catchup") {
      const proj = canon(q.project || "");
      if (!proj) return json(res, 400, { error: "project required" });
      const mine = state.tasks.filter(t => canon(t.project) === proj);
      const counts = { todo:0, doing:0, testing:0, failed:0, done:0, blocked:0 };
      for (const t of mine) counts[t.status] = (counts[t.status] || 0) + 1;
      const pick = (st, n) => mine.filter(t => t.status === st).sort((a,b)=>(b.updated||0)-(a.updated||0)).slice(0, n)
        .map(t => ({ id: t.id, title: t.title, assignee: t.assignee || "", updated: t.updated || 0 }));
      const lastActivity = mine.reduce((mx,t)=>Math.max(mx, t.updated||0), state.projectMeta[proj]?.updated || 0);
      return json(res, 200, {
        project: proj, brief: state.projectMeta[proj]?.brief || "",
        counts, total: mine.length,
        doing: pick("doing", 8), testing: pick("testing", 8), failed: pick("failed", 8),
        blocked: pick("blocked", 8), todo: pick("todo", 10), recentDone: pick("done", 8),
        lastActivity,
      });
    }
    // FLOW v2: the orchestrator-rooted phase flowchart. Returns the project's cards grouped into
    // ordered phases (title-prefix + time-cluster), each with its crew fan-out + orchestrator nodes.
    if (req.method === "GET" && P === "/phases") {
      const proj = canon(q.project || "");
      if (!proj) return json(res, 400, { error: "project required" });
      const mine = state.tasks.filter(t => canon(t.project) === proj);
      const out = derivePhases(mine);
      for (const p of out.phases) p.goal = state.phaseMeta[`${proj}::${p.key}`]?.goal || "";   // explicit goal overrides the derived theme
      return json(res, 200, { project: proj, brief: state.projectMeta[proj]?.brief || "", ...out });
    }
    // Set a phase's explicit GOAL — what this phase needs to do (the orchestrator captures this at plan
    // time, like a per-phase brief). Surfaces in the FLOW v2 header in place of the derived theme.
    if (req.method === "POST" && P === "/phase") {
      const b = await body(req);
      const proj = canon(String(b.project || "").slice(0, 80)), phase = String(b.phase || "").slice(0, 40);
      if (!proj || !phase) return json(res, 400, { error: "project + phase required" });
      const k = `${proj}::${phase}`; const m = state.phaseMeta[k] || {};
      if (b.goal !== undefined) m.goal = String(b.goal).slice(0, 400);
      m.by = b.by || m.by || ""; m.updated = now();
      state.phaseMeta[k] = m; dirty = true;
      return json(res, 200, { ok: true, project: proj, phase, goal: m.goal || "" });
    }
    if (req.method === "GET" && P === "/projects") {        // project-grouped view
      prunePeers();
      const cutoff = now() - ONLINE_MS; const byProj = {};
      const proj = p => canon(p) || "(unassigned)";
      const mk = k => (byProj[k] ||= { project: k, brief: (state.projectMeta[k]?.brief) || "", agents: [], tasks: { todo:0,doing:0,testing:0,failed:0,done:0,blocked:0 }, doingTitles: [], lastActivity: 0 });
      for (const [s, v] of Object.entries(state.peers)) {
        const k = proj(v.project); const e = mk(k); e.agents.push({ session: s, online: v.lastSeen > cutoff, status: v.status || "", health: healthOf(v.status) });
        if ((v.lastSeen || 0) > e.lastActivity) e.lastActivity = v.lastSeen;
      }
      for (const t of state.tasks) { const e = mk(proj(t.project)); e.tasks[t.status] = (e.tasks[t.status]||0)+1; if (t.status === "doing") e.doingTitles.push(t.title); if ((t.updated || 0) > e.lastActivity) e.lastActivity = t.updated; }
      // derive a one-line phase ("where it is in the process") from the board
      for (const e of Object.values(byProj)) {
        const mu = state.projectMeta[e.project]?.updated || 0; if (mu > e.lastActivity) e.lastActivity = mu;
        e.idle = !e.agents.some(a => a.online);
        const { todo, doing, testing=0, failed=0, done, blocked } = e.tasks; const total = todo+doing+testing+failed+done+blocked;
        e.phase = total === 0 ? "no cards yet"
          : failed > 0 ? `${failed} FAILED — fixing`
          : blocked > 0 ? `blocked on ${blocked} card${blocked>1?"s":""}`
          : testing > 0 ? `verifying: ${testing} in test`
          : doing > 0 ? `building: ${e.doingTitles.slice(0,2).join(", ")}${e.doingTitles.length>2?"…":""}`
          : done === total ? "shipped — all cards done"
          : todo > 0 ? `planned: ${todo} card${todo>1?"s":""} queued`
          : "in progress";
        // dead board: no live agents -> the phase above is stale, say so honestly
        if (e.idle) e.phase = `idle · last activity ${e.lastActivity ? fmtAge(now() - e.lastActivity) : "unknown"}`;
      }
      return json(res, 200, { projects: Object.values(byProj) });
    }
    // --- lessons: cross-agent learning from failures. scope = "global" or an agent brand ("kimi") ---
    if (req.method === "POST" && P === "/lesson") {
      const b = await body(req);
      const text = String(b.text || "").trim().slice(0, 400);
      const scope = String(b.scope || "global").toLowerCase().slice(0, 40);
      if (!text) return json(res, 400, { error: "text required" });
      if (state.lessons.some(l => l.scope === scope && l.text === text)) return json(res, 200, { ok: true, dedup: true });
      state.lessons.push({ id: state.lessons.length + 1, scope, text, by: b.by || "", ts: now() });
      if (state.lessons.length > 500) state.lessons.splice(0, 100);
      dirty = true; return json(res, 200, { ok: true, count: state.lessons.length });
    }
    if (req.method === "GET" && P === "/economics") {   // the brain's books, surfaced: scrooge ledger + quota profile
      const out = { scrooge: null, lifetime: null, profile: null };
      try { out.profile = JSON.parse(readFileSync(join(homedir(), ".agent-bus", "profile.json"), "utf8")).providers || {}; } catch {}
      try {
        const ledger = join(homedir(), ".token-scrooge", "calls.jsonl");
        const st = statSync(ledger);
        if (st.mtimeMs !== _ledgerCache.mtimeMs) {   // ledger changed → reparse the whole file once
          const rows = readFileSync(ledger, "utf8").trim().split("\n")
            .map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(c => c && c.ok);
          _ledgerCache = { mtimeMs: st.mtimeMs, rows };
        }
        const rows = _ledgerCache.rows;
        // Roll up a set of calls into spend + the frontier-model yardstick (~$15/M in, $75/M out,
        // same reference scrooge's own ledger uses) and the resulting savings.
        const rollup = calls => {
          const s = { calls: calls.length, tokens_in: 0, tokens_out: 0, cost_usd: 0, by_model: {} };
          for (const c of calls) {
            s.tokens_in += c.tokens_in || 0; s.tokens_out += c.tokens_out || 0; s.cost_usd += c.cost_usd || 0;
            const m = s.by_model[c.model] ||= { calls: 0, cost_usd: 0 };
            m.calls++; m.cost_usd += c.cost_usd || 0;
          }
          s.opus_equiv_usd = +(s.tokens_in * 15 / 1e6 + s.tokens_out * 75 / 1e6).toFixed(2);
          s.cost_usd = +s.cost_usd.toFixed(4);
          s.saved_usd = +Math.max(0, s.opus_equiv_usd - s.cost_usd).toFixed(2);
          return s;
        };
        // Named rolling windows the dashboard dropdown offers, all served in one response so
        // switching the selector is instant (no refetch) — cheap because the rows are cached.
        const nowS = now() / 1000;
        const WINDOWS = { "24h": 24, "week": 168, "month": 720, "quarter": 2160, "year": 8760 };
        out.windows = {};
        for (const [k, hrs] of Object.entries(WINDOWS)) out.windows[k] = rollup(rows.filter(c => c.ts >= nowS - hrs * 3600));
        out.lifetime = rollup(rows);                             // all-time running total
        out.lifetime.since_ts = rows.length ? rows[0].ts : null; // first ledgered call
        out.windows.lifetime = out.lifetime;
        // back-compat: `scrooge` is the window older dashboards read (honor ?hours= if passed)
        out.scrooge = q.hours ? rollup(rows.filter(c => c.ts >= nowS - Number(q.hours) * 3600)) : out.windows["24h"];
      } catch {}
      return json(res, 200, out);
    }
    if (req.method === "GET" && P === "/lessons") {
      const agent = (q.agent || "").toLowerCase();
      const ls = state.lessons.filter(l => l.scope === "global" || (agent && l.scope === agent));
      return json(res, 200, { lessons: ls });
    }
    // The self-learning loop, surfaced for the dashboard "Learning" sidebar: relay lessons grouped
    // (global / per-agent / per-project), per-LLM reliability from turn telemetry (+ daily series for
    // charts), and the Scrooge guardrails baked into each model's prompt (+ per-model economics).
    if (req.method === "GET" && P === "/learning") {
      const projOf = by => (by && by.includes(":")) ? by.split(":").pop() : "";
      // ts is ms (lessons/telemetry) or s (ledger). Null-safe: a malformed record with a missing/bad
      // ts must not throw (new Date(NaN).toISOString() does) and 500 the whole endpoint — return null
      // and let callers skip that day-bucket.
      const dayOf = ts => { const n = Number(ts); if (!n) return null; const d = new Date(n > 2e10 ? n : n * 1000); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };
      const ALL = "*";   // the cross-project ("All projects") bucket
      const out = { totals: {}, lessons: { global: [], byAgent: {}, byProject: {}, projects: [] }, agents: [], agentsByProject: {}, models: [], modelsByProject: {} };

      // relay lessons → global / by-agent / by-project (project derived from the recorder's session id)
      const projSet = new Set();
      for (const l of state.lessons) {
        const rec = { text: l.text, scope: l.scope, by: l.by || "", project: projOf(l.by), ts: l.ts || 0 };
        if (l.scope === "global") out.lessons.global.push(rec); else (out.lessons.byAgent[l.scope] ||= []).push(rec);
        if (rec.project) { (out.lessons.byProject[rec.project] ||= []).push(rec); projSet.add(rec.project); }
      }

      // per-LLM reliability from turn telemetry, bucketed BY PROJECT (+ a global ALL bucket) so the
      // sidebar's project filter scopes the charts. Each turn carries its own project.
      const turns = scanTelemetry();
      const relAgg = {};       // scope -> agent -> {turns,failures,models:Set,lastFailure,days}
      const scopeModels = {};  // scope -> Set(model used)
      let totalTurns = 0, totalFails = 0;
      const bumpRel = (scope, t) => {
        const a = ((relAgg[scope] ||= {})[t.agent] ||= { agent: t.agent, turns: 0, failures: 0, models: new Set(), lastFailure: null, days: {} });
        a.turns++;
        if (t.model) { a.models.add(t.model); if (t.model !== "default") (scopeModels[scope] ||= new Set()).add(t.model); }
        const dk = dayOf(t.ts); const d = dk ? (a.days[dk] ||= { turns: 0, failures: 0 }) : null; if (d) d.turns++;
        if (t.exit && t.exit !== 0) { a.failures++; if (d) d.failures++; if (!a.lastFailure || t.ts > a.lastFailure.ts) a.lastFailure = { ts: t.ts, exit: t.exit, project: t.project || "" }; }
      };
      for (const t of turns) {
        if (!t.agent) continue;
        totalTurns++; if (t.exit && t.exit !== 0) totalFails++;
        bumpRel(ALL, t);
        if (t.project) { bumpRel(t.project, t); projSet.add(t.project); }
      }
      // lessons-accumulated-over-time per scope -> agent brand -> day (agent-scoped lessons only)
      const lessonAgg = {};
      for (const l of state.lessons) {
        if (l.scope === "global") continue; const d = dayOf(l.ts); if (!d) continue;
        const bump = scope => { (((lessonAgg[scope] ||= {})[l.scope] ||= {})[d]) = (lessonAgg[scope][l.scope][d] || 0) + 1; };
        bump(ALL); const p = projOf(l.by); if (p) bump(p);
      }
      const buildAgents = scope => Object.values(relAgg[scope] || {}).sort((a, b) => b.turns - a.turns).map(a => {
        const days = Object.keys(a.days).sort(); let cum = 0; const ld = (lessonAgg[scope] || {})[a.agent] || {};
        return { agent: a.agent, turns: a.turns, failures: a.failures, failRate: a.turns ? +(a.failures / a.turns).toFixed(3) : 0,
          lastFailure: a.lastFailure, models: [...a.models],
          series: {
            failRate: days.map(d => ({ day: d, turns: a.days[d].turns, failures: a.days[d].failures, rate: a.days[d].turns ? +(a.days[d].failures / a.days[d].turns).toFixed(3) : 0 })),
            lessons: Object.keys(ld).sort().map(d => ({ day: d, count: (cum += ld[d]) })),
          } };
      });

      // Scrooge guardrails (global per model) + per-model economics from the ledger, bucketed by project
      let guard = {}; try { guard = JSON.parse(readFileSync(join(homedir(), ".token-scrooge", "lessons.json"), "utf8")) || {}; } catch {}
      try { const lp = join(homedir(), ".token-scrooge", "calls.jsonl"); const st = statSync(lp); if (st.mtimeMs !== _ledgerCache.mtimeMs) { const rows = readFileSync(lp, "utf8").trim().split("\n").map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(c => c && c.ok); _ledgerCache = { mtimeMs: st.mtimeMs, rows }; } } catch {}
      const ledAgg = {};   // scope -> model -> {calls,ti,to,cost,days}
      const bumpLed = (scope, c) => {
        const m = ((ledAgg[scope] ||= {})[c.model] ||= { calls: 0, ti: 0, to: 0, cost: 0, days: {} });
        m.calls++; m.ti += c.tokens_in || 0; m.to += c.tokens_out || 0; m.cost += c.cost_usd || 0;
        const dk = dayOf(c.ts); if (dk) { const d = (m.days[dk] ||= { cost: 0, ti: 0, to: 0 }); d.cost += c.cost_usd || 0; d.ti += c.tokens_in || 0; d.to += c.tokens_out || 0; }
        (scopeModels[scope] ||= new Set()).add(c.model);
      };
      for (const c of _ledgerCache.rows) { if (!c.model) continue; bumpLed(ALL, c); if (c.project) { bumpLed(c.project, c); projSet.add(c.project); } }

      const savedOf = (ti, to, cost) => +Math.max(0, ti * 15 / 1e6 + to * 75 / 1e6 - cost).toFixed(2);
      let totalGuardrails = 0;
      const mkModel = (scope, model, g) => {
        const gcount = Object.values(g || {}).reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0);
        if (scope === ALL) totalGuardrails += gcount;   // guardrails are global — count once
        const lm = (ledAgg[scope] || {})[model];
        return { model, guardrails: g || {}, guardrailCount: gcount, calls: lm ? lm.calls : 0, cost_usd: lm ? +lm.cost.toFixed(4) : 0,
          saved_usd: lm ? savedOf(lm.ti, lm.to, lm.cost) : 0,
          series: { saved: lm ? Object.keys(lm.days).sort().map(d => ({ day: d, saved: savedOf(lm.days[d].ti, lm.days[d].to, lm.days[d].cost) })) : [] } };
      };
      const buildModels = scope => {
        const keys = new Set(scopeModels[scope] || []);          // models used in this scope
        if (scope === ALL) for (const k of Object.keys(guard)) if (k !== "*") keys.add(k);   // global view also lists every guardrailed model
        const arr = [...keys].sort().map(m => mkModel(scope, m, guard[m]));
        if (guard["*"]) arr.unshift(mkModel(scope, "∗ all models", guard["*"]));   // guardrails that apply to every model
        return arr;
      };

      out.lessons.projects = [...projSet].sort();
      out.agents = buildAgents(ALL); out.models = buildModels(ALL);
      for (const p of out.lessons.projects) { out.agentsByProject[p] = buildAgents(p); out.modelsByProject[p] = buildModels(p); }

      out.totals = { lessons: state.lessons.length, guardrails: totalGuardrails, turns: totalTurns, failures: totalFails, failRate: totalTurns ? +(totalFails / totalTurns).toFixed(3) : 0, models: out.models.length };
      return json(res, 200, out);
    }
    if (req.method === "POST" && P === "/send") {
      const b = await body(req);
      if (!b.from || !String(b.text ?? "").trim()) return json(res, 400, { error: "from and non-empty text required" });
      touch(b.from);
      // attribute the message to a project so the dashboard can show it in that project's lane.
      // explicit b.project wins; else the sender's known project; else parsed from a "host:project" id.
      const fromProj = state.peers[b.from]?.project || (b.from && b.from.includes(":") ? b.from.split(":").pop() : "");
      const msg = { id: ++state.seq, ts: now(), from: b.from || "anon", to: b.to || "all", text: String(b.text ?? ""), project: String(b.project || fromProj || "").slice(0, 80) };
      state.messages.push(msg); if (state.messages.length > 5000) state.messages.splice(0, 1000);
      dirty = true; pushToStreams(msg);               // <-- instant push to live watchers
      return json(res, 200, { ok: true, id: msg.id });
    }
    if (req.method === "GET" && P === "/inbox") {
      touch(q.session); const since = Number(q.since || 0);
      const msgs = state.messages.filter(m => m.id > since && deliverable(m, q.session));
      return json(res, 200, { messages: msgs, cursor: msgs.length ? msgs[msgs.length - 1].id : since });
    }
    if (req.method === "GET" && P === "/poll") {
      touch(q.session); const since = Number(q.since || 0);
      const waitMs = Math.min(Number(q.wait || 25), 290) * 1000;   // allow long idle-park
      const deadline = now() + waitMs;
      const tick = () => {
        const msgs = state.messages.filter(m => m.id > since && deliverable(m, q.session));
        if (msgs.length || now() >= deadline) { touch(q.session); return json(res, 200, { messages: msgs, cursor: msgs.length ? msgs[msgs.length - 1].id : since }); }
        setTimeout(tick, 300);
      };
      return tick();
    }
    if (req.method === "GET" && P === "/stream") {                 // SSE — true push, no polling
      const session = q.session || "all";
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive", "access-control-allow-origin": "*" });
      res.write(`: connected as ${session}\n\n`);
      touch(session, q.status);
      const entry = { session, res };
      streams.push(entry);
      const ka = setInterval(() => { try { res.write(": ka\n\n"); touch(session); } catch {} }, 20000);
      req.on("close", () => { clearInterval(ka); const i = streams.indexOf(entry); if (i >= 0) streams.splice(i, 1); });
      return;
    }
    if (req.method === "GET" && P === "/recent") {   // god-view: last N messages, for the dashboard feed
      const n = Math.min(Number(q.limit || 50), 200);
      return json(res, 200, { messages: state.messages.slice(-n) });
    }
    if (req.method === "GET" && (P === "/" || P === "/ui")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(UI || "<h1>trantor</h1><p>dashboard unavailable</p>");
    }
    if (P === "/health") return json(res, 200, { ok: true, peers: Object.keys(state.peers).length, messages: state.messages.length, streams: streams.length });
    json(res, 404, { error: "not found" });
  } catch (e) { json(res, 500, { error: String(e?.message || e) }); }
});
server.listen(PORT, HOST, () => console.error(`[trantor] hub on http://${HOST}:${PORT} (data: ${DATA})`));

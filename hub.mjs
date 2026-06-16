#!/usr/bin/env node
// trantor hub — message bus + presence/status board + SSE push, so independent
// Claude Code sessions can coordinate (near-instant for watchers, cheap for idle peers).
// Binds to LOOPBACK (127.0.0.1) by default — local-first and safe (no auth yet). To let other
// machines reach it (e.g. over a Tailscale tailnet), set RELAY_HOST=0.0.0.0 — but only on a
// private network, or add auth first. See "Always-on / remote hub" in the README (roadmap).
import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.RELAY_PORT || 4477);
const HOST = process.env.RELAY_HOST || "127.0.0.1";
const DATA_DIR = process.env.RELAY_DATA_DIR || join(homedir(), ".agent-bus");
const DATA = join(DATA_DIR, "bus.json");
const ONLINE_MS = Number(process.env.RELAY_ONLINE_MS || 5 * 60 * 1000);
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// Scrooge ledger cache: /economics is polled every ~15s by the dashboard, but the ledger
// (~/.token-scrooge/calls.jsonl) only changes when a cheap-model call lands. Re-parse the whole
// file only when its mtime moves; otherwise reuse the parsed rows. Keeps the lifetime running
// total cheap to serve no matter how big the ledger grows.
let _ledgerCache = { mtimeMs: -1, rows: [] };

// peers: { session: { lastSeen, status, project } } ; tasks: kanban cards
// projectMeta: { project: { brief, by, updated } } — the "what & why" blurb per project
let state = { messages: [], peers: {}, seq: 0, tasks: [], taskSeq: 0, projectMeta: {}, lessons: [] };
try {
  if (existsSync(DATA)) {
    const loaded = JSON.parse(readFileSync(DATA, "utf8"));
    state = { messages: loaded.messages || [], peers: {}, seq: loaded.seq || 0, tasks: loaded.tasks || [], taskSeq: loaded.taskSeq || 0, projectMeta: loaded.projectMeta || {}, lessons: loaded.lessons || [] };
    for (const [s, v] of Object.entries(loaded.peers || {})) // migrate old numeric form
      state.peers[s] = typeof v === "number" ? { lastSeen: v, status: "", project: "" } : { lastSeen: v.lastSeen || 0, status: v.status || "", project: v.project || "" };
  }
} catch {}
let dirty = false;
const persist = () => { if (dirty) { try { writeFileSync(DATA, JSON.stringify(state)); dirty = false; } catch {} } };
setInterval(persist, 1000).unref?.();

// dashboard HTML (read once at startup)
let UI = "";
try { UI = readFileSync(new URL("./ui.html", import.meta.url), "utf8"); } catch {}

// open SSE streams: [{ session, res }]
const streams = [];
const now = () => Date.now();
const fmtAge = ms => { const m = Math.floor(ms / 60000); return m > 48 * 60 ? `${Math.floor(m / 1440)}d ago` : m > 90 ? `${Math.floor(m / 60)}h ago` : `${m}m ago`; };
function body(req) { return new Promise(r => { let d = ""; req.on("data", c => (d += c)); req.on("end", () => { try { r(d ? JSON.parse(d) : {}); } catch { r({}); } }); }); }
function json(res, code, obj) { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(obj)); }
function touch(session, status, project) {
  if (!session || session === "all") return;   // "all" is a wildcard, not a real peer
  const p = state.peers[session] || { lastSeen: 0, status: "", project: "" };
  p.lastSeen = now();
  if (status !== undefined) p.status = String(status).slice(0, 280);
  if (project) p.project = String(project).slice(0, 80);
  // derive project from a "host:project" session id if none given
  if (!p.project && session.includes(":")) p.project = session.split(":").pop().slice(0, 80);
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

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"); const q = Object.fromEntries(u.searchParams); const P = u.pathname;
  try {
    if (req.method === "POST" && P === "/register") { const b = await body(req); touch(b.session, b.status, b.project); return json(res, 200, { ok: true, session: b.session, peers: Object.keys(state.peers) }); }
    if (req.method === "POST" && P === "/status") { const b = await body(req); touch(b.session, b.status ?? "", b.project); return json(res, 200, { ok: true }); }
    if (req.method === "GET" && P === "/peers") {
      const cutoff = now() - ONLINE_MS;
      return json(res, 200, { peers: Object.entries(state.peers).map(([s, v]) => ({ session: s, lastSeen: v.lastSeen, online: v.lastSeen > cutoff, status: v.status || "", health: healthOf(v.status), project: v.project || "" })) });
    }
    // --- Kanban tasks ---
    if (req.method === "POST" && P === "/task") {           // create a card
      const b = await body(req); touch(b.by, undefined, b.project);
      const st0 = ["todo","doing","testing","failed","done","blocked"].includes(b.status) ? b.status : "todo";
      const t = { id: ++state.taskSeq, project: String(b.project || "").slice(0,80), title: String(b.title||"").slice(0,200),
        assignee: b.assignee || "", status: st0,
        difficulty: ["easy","medium","hard"].includes(b.difficulty) ? b.difficulty : "",
        model: String(b.model || "").slice(0, 60),
        deps: Array.isArray(b.deps) ? [...new Set(b.deps.map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 20) : [],
        by: b.by || "", ts: now(), updated: now(),
        history: [{ to: st0, by: b.by || "", ts: now() }] };
      state.tasks.push(t); if (state.tasks.length > 2000) state.tasks.splice(0, 500);
      dirty = true; return json(res, 200, { ok: true, task: t });
    }
    if (req.method === "POST" && P === "/task/update") {    // move/edit a card
      const b = await body(req); const t = state.tasks.find(x => x.id === Number(b.id));
      if (!t) return json(res, 404, { error: "no such task" });
      if (b.status && ["todo","doing","testing","failed","done","blocked"].includes(b.status) && b.status !== t.status) {
        (t.history ||= []).push({ from: t.status, to: b.status, by: b.by || "", ts: now() });
        if (t.history.length > 40) t.history.splice(0, 10);
        t.status = b.status;
      }
      if (b.difficulty && ["easy","medium","hard"].includes(b.difficulty)) t.difficulty = b.difficulty;
      if (b.model !== undefined) t.model = String(b.model).slice(0, 60);
      if (Array.isArray(b.deps)) t.deps = [...new Set(b.deps.map(Number).filter(n => Number.isInteger(n) && n > 0 && n !== t.id))].slice(0, 20);
      if (b.assignee !== undefined) t.assignee = b.assignee;
      if (b.title !== undefined) t.title = String(b.title).slice(0,200);
      if (b.delete) state.tasks = state.tasks.filter(x => x.id !== t.id);
      t.updated = now(); dirty = true; return json(res, 200, { ok: true, task: t });
    }
    if (req.method === "GET" && P === "/tasks") {
      const proj = q.project; const ts = proj ? state.tasks.filter(t => t.project === proj) : state.tasks;
      return json(res, 200, { tasks: ts });
    }
    if (req.method === "POST" && P === "/project") {        // set a project's brief (what & why)
      const b = await body(req); const k = String(b.project || "").slice(0, 80);
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
    if (req.method === "GET" && P === "/projects") {        // project-grouped view
      const cutoff = now() - ONLINE_MS; const byProj = {};
      const proj = p => p || "(unassigned)";
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

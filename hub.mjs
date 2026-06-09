#!/usr/bin/env node
// agent-bus hub — message bus + presence/status board + SSE push, so independent
// Claude Code sessions can coordinate (near-instant for watchers, cheap for idle peers).
// Binds to LOOPBACK (127.0.0.1) by default — local-first and safe (no auth yet). To let other
// machines reach it (e.g. over a Tailscale tailnet), set RELAY_HOST=0.0.0.0 — but only on a
// private network, or add auth first. See "Always-on / remote hub" in the README (roadmap).
import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.RELAY_PORT || 4477);
const HOST = process.env.RELAY_HOST || "127.0.0.1";
const DATA_DIR = join(homedir(), ".agent-bus");
const DATA = join(DATA_DIR, "bus.json");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// peers: { session: { lastSeen, status, project } } ; tasks: kanban cards
// projectMeta: { project: { brief, by, updated } } — the "what & why" blurb per project
let state = { messages: [], peers: {}, seq: 0, tasks: [], taskSeq: 0, projectMeta: {} };
try {
  if (existsSync(DATA)) {
    const loaded = JSON.parse(readFileSync(DATA, "utf8"));
    state = { messages: loaded.messages || [], peers: {}, seq: loaded.seq || 0, tasks: loaded.tasks || [], taskSeq: loaded.taskSeq || 0, projectMeta: loaded.projectMeta || {} };
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
      const cutoff = now() - 5 * 60 * 1000;
      return json(res, 200, { peers: Object.entries(state.peers).map(([s, v]) => ({ session: s, lastSeen: v.lastSeen, online: v.lastSeen > cutoff, status: v.status || "", project: v.project || "" })) });
    }
    // --- Kanban tasks ---
    if (req.method === "POST" && P === "/task") {           // create a card
      const b = await body(req); touch(b.by, undefined, b.project);
      const t = { id: ++state.taskSeq, project: String(b.project || "").slice(0,80), title: String(b.title||"").slice(0,200),
        assignee: b.assignee || "", status: ["todo","doing","testing","failed","done","blocked"].includes(b.status) ? b.status : "todo",
        by: b.by || "", ts: now(), updated: now() };
      state.tasks.push(t); if (state.tasks.length > 2000) state.tasks.splice(0, 500);
      dirty = true; return json(res, 200, { ok: true, task: t });
    }
    if (req.method === "POST" && P === "/task/update") {    // move/edit a card
      const b = await body(req); const t = state.tasks.find(x => x.id === Number(b.id));
      if (!t) return json(res, 404, { error: "no such task" });
      if (b.status && ["todo","doing","testing","failed","done","blocked"].includes(b.status)) t.status = b.status;
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
    if (req.method === "GET" && P === "/projects") {        // project-grouped view
      const cutoff = now() - 5 * 60 * 1000; const byProj = {};
      const proj = p => p || "(unassigned)";
      const mk = k => (byProj[k] ||= { project: k, brief: (state.projectMeta[k]?.brief) || "", agents: [], tasks: { todo:0,doing:0,testing:0,failed:0,done:0,blocked:0 }, doingTitles: [] });
      for (const [s, v] of Object.entries(state.peers)) {
        const k = proj(v.project); mk(k).agents.push({ session: s, online: v.lastSeen > cutoff, status: v.status || "" });
      }
      for (const t of state.tasks) { const e = mk(proj(t.project)); e.tasks[t.status] = (e.tasks[t.status]||0)+1; if (t.status === "doing") e.doingTitles.push(t.title); }
      // derive a one-line phase ("where it is in the process") from the board
      for (const e of Object.values(byProj)) {
        const { todo, doing, testing=0, failed=0, done, blocked } = e.tasks; const total = todo+doing+testing+failed+done+blocked;
        e.phase = total === 0 ? "no cards yet"
          : failed > 0 ? `${failed} FAILED — fixing`
          : blocked > 0 ? `blocked on ${blocked} card${blocked>1?"s":""}`
          : testing > 0 ? `verifying: ${testing} in test`
          : doing > 0 ? `building: ${e.doingTitles.slice(0,2).join(", ")}${e.doingTitles.length>2?"…":""}`
          : done === total ? "shipped — all cards done"
          : todo > 0 ? `planned: ${todo} card${todo>1?"s":""} queued`
          : "in progress";
      }
      return json(res, 200, { projects: Object.values(byProj) });
    }
    if (req.method === "POST" && P === "/send") {
      const b = await body(req); touch(b.from);
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
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(UI || "<h1>agent-bus</h1><p>dashboard unavailable</p>");
    }
    if (P === "/health") return json(res, 200, { ok: true, peers: Object.keys(state.peers).length, messages: state.messages.length, streams: streams.length });
    json(res, 404, { error: "not found" });
  } catch (e) { json(res, 500, { error: String(e?.message || e) }); }
});
server.listen(PORT, HOST, () => console.error(`[agent-bus] hub on http://${HOST}:${PORT} (data: ${DATA})`));

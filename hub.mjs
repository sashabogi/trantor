#!/usr/bin/env node
// agent-bus hub — message bus + presence/status board + SSE push, so independent
// Claude Code sessions can coordinate (near-instant for watchers, cheap for idle peers).
// Binds to 0.0.0.0 by default so localhost AND Tailscale peers reach it.
import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.RELAY_PORT || 4477);
const HOST = process.env.RELAY_HOST || "0.0.0.0";
const DATA_DIR = join(homedir(), ".agent-bus");
const DATA = join(DATA_DIR, "bus.json");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// peers: { session: { lastSeen, status } }
let state = { messages: [], peers: {}, seq: 0 };
try {
  if (existsSync(DATA)) {
    const loaded = JSON.parse(readFileSync(DATA, "utf8"));
    state = { messages: loaded.messages || [], peers: {}, seq: loaded.seq || 0 };
    for (const [s, v] of Object.entries(loaded.peers || {})) // migrate old numeric form
      state.peers[s] = typeof v === "number" ? { lastSeen: v, status: "" } : { lastSeen: v.lastSeen || 0, status: v.status || "" };
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
function touch(session, status) {
  if (!session || session === "all") return;   // "all" is a wildcard, not a real peer
  const p = state.peers[session] || { lastSeen: 0, status: "" };
  p.lastSeen = now();
  if (status !== undefined) p.status = String(status).slice(0, 280);
  state.peers[session] = p; dirty = true;
}
function deliverable(m, session) { return (m.to === session || m.to === "all") && m.from !== session; }
function pushToStreams(msg) {
  for (const s of streams) if (deliverable(msg, s.session)) { try { s.res.write(`data: ${JSON.stringify(msg)}\n\n`); } catch {} }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"); const q = Object.fromEntries(u.searchParams); const P = u.pathname;
  try {
    if (req.method === "POST" && P === "/register") { const b = await body(req); touch(b.session, b.status); return json(res, 200, { ok: true, session: b.session, peers: Object.keys(state.peers) }); }
    if (req.method === "POST" && P === "/status") { const b = await body(req); touch(b.session, b.status ?? ""); return json(res, 200, { ok: true }); }
    if (req.method === "GET" && P === "/peers") {
      const cutoff = now() - 5 * 60 * 1000;
      return json(res, 200, { peers: Object.entries(state.peers).map(([s, v]) => ({ session: s, lastSeen: v.lastSeen, online: v.lastSeen > cutoff, status: v.status || "" })) });
    }
    if (req.method === "POST" && P === "/send") {
      const b = await body(req); touch(b.from);
      const msg = { id: ++state.seq, ts: now(), from: b.from || "anon", to: b.to || "all", text: String(b.text ?? "") };
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

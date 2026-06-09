#!/usr/bin/env node
// claude-relay hub — a tiny message bus that lets independent Claude Code sessions
// talk live. Binds to 0.0.0.0 so localhost AND Tailscale peers both reach it.
// State persists to a JSON file so the bus survives a restart.
import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.RELAY_PORT || 4477);
const HOST = process.env.RELAY_HOST || "0.0.0.0";
const DATA_DIR = join(homedir(), ".claude-relay");
const DATA = join(DATA_DIR, "bus.json");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

let state = { messages: [], peers: {}, seq: 0 };
try { if (existsSync(DATA)) state = JSON.parse(readFileSync(DATA, "utf8")); } catch {}
let dirty = false;
const persist = () => { if (dirty) { try { writeFileSync(DATA, JSON.stringify(state)); dirty = false; } catch {} } };
setInterval(persist, 1000).unref?.();

const now = () => Date.now();
function body(req) {
  return new Promise(res => { let d = ""; req.on("data", c => (d += c)); req.on("end", () => { try { res(d ? JSON.parse(d) : {}); } catch { res({}); } }); });
}
function json(res, code, obj) { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); }
function touch(session) { if (session) { state.peers[session] = now(); dirty = true; } }
function inbox(session, since) {
  return state.messages.filter(m => m.id > since && (m.to === session || m.to === "all") && m.from !== session);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://x`);
  const q = Object.fromEntries(u.searchParams);
  try {
    if (req.method === "POST" && u.pathname === "/register") {
      const b = await body(req); touch(b.session);
      return json(res, 200, { ok: true, session: b.session, peers: Object.keys(state.peers) });
    }
    if (req.method === "GET" && u.pathname === "/peers") {
      const cutoff = now() - 5 * 60 * 1000;
      const peers = Object.entries(state.peers).map(([s, t]) => ({ session: s, lastSeen: t, online: t > cutoff }));
      return json(res, 200, { peers });
    }
    if (req.method === "POST" && u.pathname === "/send") {
      const b = await body(req); touch(b.from);
      const msg = { id: ++state.seq, ts: now(), from: b.from || "anon", to: b.to || "all", text: String(b.text ?? "") };
      state.messages.push(msg); if (state.messages.length > 5000) state.messages.splice(0, 1000);
      dirty = true; return json(res, 200, { ok: true, id: msg.id });
    }
    if (req.method === "GET" && u.pathname === "/inbox") {
      touch(q.session); const since = Number(q.since || 0);
      const msgs = inbox(q.session, since);
      const cursor = msgs.length ? msgs[msgs.length - 1].id : since;
      return json(res, 200, { messages: msgs, cursor });
    }
    if (req.method === "GET" && u.pathname === "/poll") {
      touch(q.session); const since = Number(q.since || 0);
      const waitMs = Math.min(Number(q.wait || 25), 55) * 1000;
      const deadline = now() + waitMs;
      const tick = () => {
        const msgs = inbox(q.session, since);
        if (msgs.length || now() >= deadline) {
          touch(q.session);
          return json(res, 200, { messages: msgs, cursor: msgs.length ? msgs[msgs.length - 1].id : since });
        }
        setTimeout(tick, 400);
      };
      return tick();
    }
    if (u.pathname === "/health") return json(res, 200, { ok: true, peers: Object.keys(state.peers).length, messages: state.messages.length });
    json(res, 404, { error: "not found" });
  } catch (e) { json(res, 500, { error: String(e?.message || e) }); }
});
server.listen(PORT, HOST, () => console.error(`[claude-relay] hub on http://${HOST}:${PORT} (data: ${DATA})`));

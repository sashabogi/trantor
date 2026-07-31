#!/usr/bin/env node
// relay-watch — a live feed of the bus via SSE (true push, no polling). Run in a terminal
// to watch sessions talk in real time, or to monitor a presence/status board.
//   node bin/relay-watch.mjs [session]   (default: "all" — see every message)
// Signed + per-project hub (2026-07-31, agent-UX audit): the hand-rolled relayUrl() here read
// only the global config `url` (wrong hub for a migrated project) and fetched unsigned (dead
// 401 under RELAY_AUTH=enforce). Now: canonical resolver + this session's keypair on every call.
import { resolveProject, hostId, resolveHub } from "../lib/project.mjs";
import { loadOrCreate } from "../lib/identity.mjs";
import { sfetch, sfetchJson } from "../lib/signed-fetch.mjs";

const PROJECT = resolveProject(process.cwd());
const ME = process.env.RELAY_SESSION
  || (process.env.RELAY_AGENT ? `${process.env.RELAY_AGENT}:${PROJECT}` : `${hostId()}:${PROJECT}`);
const identity = loadOrCreate(ME, "agent");
const URL_BASE = resolveHub(PROJECT);
const SESSION = process.argv[2] || "all";
const t = () => new Date().toLocaleTimeString();

async function showPeers() {
  try {
    const { peers } = await (await sfetchJson(`${URL_BASE}/peers`, { method: "GET", identity })).json();
    const live = peers.filter(p => p.online);
    console.log(`\n  live sessions (${live.length}):`);
    for (const p of live) console.log(`   🟢 ${p.session}${p.status ? `  — ${p.status}` : ""}`);
    console.log("");
  } catch {}
}

async function watch() {
  console.log(`relay-watch → ${URL_BASE}  (watching "${SESSION}")  —  Ctrl-C to stop`);
  await showPeers();
  for (;;) {
    try {
      const r = await sfetch(`${URL_BASE}/stream?session=${encodeURIComponent(SESSION)}`, { headers: { accept: "text/event-stream" } }, identity);
      if (!r.ok || !r.body) throw new Error(`stream ${r.status}`);
      let buf = "";
      const dec = new TextDecoder();
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try { const m = JSON.parse(line.slice(5).trim()); console.log(`  [${t()}] ${m.from} → ${m.to}: ${m.text}`); } catch {}
          }
        }
      }
    } catch (e) {
      console.error(`  (stream dropped: ${e?.message || e} — reconnecting in 2s)`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}
watch();

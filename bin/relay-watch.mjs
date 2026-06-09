#!/usr/bin/env node
// relay-watch — a live feed of the bus via SSE (true push, no polling). Run in a terminal
// to watch sessions talk in real time, or to monitor a presence/status board.
//   node bin/relay-watch.mjs [session]   (default: "all" — see every message)
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function relayUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL;
  try { const c = join(homedir(), ".agent-bus", "config.json"); if (existsSync(c)) { const u = JSON.parse(readFileSync(c, "utf8")).url; if (u) return u; } } catch {}
  return "http://127.0.0.1:4477";
}
const URL_BASE = relayUrl();
const SESSION = process.argv[2] || "all";
const t = () => new Date().toLocaleTimeString();

async function showPeers() {
  try {
    const { peers } = await (await fetch(`${URL_BASE}/peers`)).json();
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
      const r = await fetch(`${URL_BASE}/stream?session=${encodeURIComponent(SESSION)}`, { headers: { accept: "text/event-stream" } });
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

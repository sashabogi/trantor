#!/usr/bin/env node
// claude-relay SessionStart hook — every session auto-registers with the hub and
// gets a roster of OTHER live sessions injected into context, so independent
// sessions discover each other automatically (locally or across machines).
//
// Config resolution (first hit wins):
//   env RELAY_URL  →  ~/.claude-relay/config.json {"url": "..."}  →  http://127.0.0.1:4477
// Identity: env RELAY_SESSION  →  "<hostname>:<basename(cwd)>"  (stable per project/machine)
import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir, hostname } from "node:os";

function relayUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL;
  try {
    const cfg = join(homedir(), ".claude-relay", "config.json");
    if (existsSync(cfg)) { const u = JSON.parse(readFileSync(cfg, "utf8")).url; if (u) return u; }
  } catch {}
  return "http://127.0.0.1:4477";
}
function readStdin() {
  return new Promise(res => { let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => (d += c)); process.stdin.on("end", () => res(d));
    setTimeout(() => res(d), 100); });
}
async function jget(u) { const r = await fetch(u, { signal: AbortSignal.timeout(2500) }); return r.json(); }
async function jpost(u, b) { return fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(2500) }); }

let additionalContext = "";
try {
  await readStdin();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const session = process.env.RELAY_SESSION || `${hostname()}:${basename(projectDir)}`;
  const url = relayUrl();

  // register self
  await jpost(`${url}/register`, { session }).catch(() => {});

  // fetch roster of OTHER online sessions
  let peers = [];
  try { peers = (await jget(`${url}/peers`)).peers || []; } catch {}
  const others = peers.filter(p => p.online && p.session !== session);

  process.stderr.write(`[claude-relay] registered as ${session} -> ${url} (${others.length} other live session(s))\n`);

  if (others.length > 0) {
    additionalContext += `<claude-relay session="${session}" hub="${url}">\n`;
    additionalContext += `You are connected to the claude-relay session bus as "${session}". Other LIVE Claude Code sessions are running right now:\n`;
    for (const p of others) additionalContext += `- ${p.session}\n`;
    additionalContext += `Use the relay MCP tools (relay_peers, relay_send, relay_inbox, relay_wait) to coordinate with them — hand off work, check for overlap before editing shared files, or ask another session for help. If a sibling session is touching the same project, coordinate before making conflicting changes.\n`;
    additionalContext += `</claude-relay>\n`;
  }
} catch (err) {
  process.stderr.write(`[claude-relay] sessionstart error: ${err?.message || err}\n`);
}

// Hook protocol: emit additionalContext via stdout JSON
process.stdout.write(JSON.stringify(additionalContext
  ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }
  : {}));
process.exit(0);

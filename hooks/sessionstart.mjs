#!/usr/bin/env node
// trantor SessionStart hook — every session auto-registers with the hub and
// gets a roster of OTHER live sessions injected into context, so independent
// sessions discover each other automatically (locally or across machines).
//
// Config resolution (first hit wins):
//   env RELAY_URL  →  ~/.agent-bus/config.json {"url": "..."}  →  http://127.0.0.1:4477
// Identity: env RELAY_SESSION  →  "<hostname>:<basename(cwd)>"  (stable per project/machine)
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir, hostname } from "node:os";

// Load the most recent UNCONSUMED handoff for this project (written by precompact.mjs).
function loadPendingHandoff(projectName) {
  try {
    const dir = join(homedir(), ".agent-bus", "handoffs");
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter(f => f.startsWith(projectName + "-") && f.endsWith(".json")).sort().reverse();
    for (const f of files) {
      const p = join(dir, f);
      const rec = JSON.parse(readFileSync(p, "utf8"));
      if (!rec.consumed) {
        rec.consumed = true; writeFileSync(p, JSON.stringify(rec, null, 2)); // claim it
        return rec;
      }
    }
  } catch {}
  return null;
}

function relayUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL;
  try {
    const cfg = join(homedir(), ".agent-bus", "config.json");
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

// Strip control chars from untrusted injected text so the hook's JSON stdout (which
// Claude Code parses) stays valid. Keeps tab/newline/CR; replaces 0x00-0x1F (minus
// those), DEL, and the JS line/paragraph separators.
function sanitize(s) {
  let out = "";
  for (const ch of String(s ?? "")) {
    const c = ch.codePointAt(0);
    const bad = (c < 0x20 && c !== 9 && c !== 10 && c !== 13) || c === 0x7f || c === 0x2028 || c === 0x2029;
    out += bad ? " " : ch;
  }
  return out;
}

let additionalContext = "";
try {
  await readStdin();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const session = process.env.RELAY_SESSION || `${hostname()}:${basename(projectDir)}`;
  const url = relayUrl();

  // register self + post an initial presence status (no LLM turn — instant for others to read)
  await jpost(`${url}/register`, { session, project: basename(projectDir), status: `active in ${basename(projectDir)}` }).catch(() => {});

  // fetch roster of OTHER online sessions
  let peers = [];
  try { peers = (await jget(`${url}/peers`)).peers || []; } catch {}
  const others = peers.filter(p => p.online && p.session !== session);

  process.stderr.write(`[trantor] registered as ${session} -> ${url} (${others.length} other live session(s))\n`);

  if (others.length > 0) {
    additionalContext += `<trantor session="${session}" hub="${url}">\n`;
    additionalContext += `You are connected to Trantor (the cross-agent session bus) as "${session}". Other LIVE agent sessions are running right now:\n`;
    for (const p of others) additionalContext += `- ${sanitize(p.session)}\n`;
    additionalContext += `Use the relay MCP tools (relay_peers, relay_send, relay_inbox, relay_wait) to coordinate with them — hand off work, check for overlap before editing shared files, or ask another session for help. If a sibling session is touching the same project, coordinate before making conflicting changes.\n`;
    additionalContext += `</trantor>\n`;
  }

  // Pending handoff? A prior session hit the context limit and left a handoff for this
  // project — take over with this fresh full window instead of starting cold.
  const handoff = loadPendingHandoff(basename(projectDir));
  if (handoff) {
    process.stderr.write(`[trantor] loaded pending handoff ${handoff.id}\n`);
    additionalContext += `<trantor-handoff id="${sanitize(handoff.id)}" from="${sanitize(handoff.machine)}" trigger="${sanitize(handoff.trigger)}">\n`;
    additionalContext += `🔄 **You are taking over from a prior session that hit its context limit.** This is a fresh full window. Resume the work below — the prior session's summary, git state, and a pointer to its full transcript (searchable; Foundation/Gaia has it ingested) follow. Continue from "OPEN THREADS & NEXT STEPS"; do not restart from scratch.\n\n`;
    additionalContext += `## Handoff summary\n${sanitize(handoff.summary)}\n`;
    if (handoff.gitStatus) additionalContext += `\n## Git working-tree at handoff\n\`\`\`\n${sanitize(handoff.gitStatus)}\n\`\`\`\n`;
    if (handoff.transcript_path) additionalContext += `\n_Full prior transcript: ${sanitize(handoff.transcript_path)}_\n`;
    additionalContext += `</trantor-handoff>\n`;
  }
} catch (err) {
  process.stderr.write(`[trantor] sessionstart error: ${err?.message || err}\n`);
}

// Hook protocol: emit additionalContext via stdout JSON. Self-validate so we never
// emit something Claude Code can't parse — fall back to sanitized, then to {}.
function emit(ctx) {
  const obj = ctx ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } } : {};
  const out = JSON.stringify(obj);
  try { JSON.parse(out); return out; } catch { /* fall through */ }
  try { return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: sanitize(ctx) } }); } catch { return "{}"; }
}
process.stdout.write(emit(additionalContext));
process.exit(0);

#!/usr/bin/env node
// trantor PostToolUse heartbeat — keeps a live session's presence fresh on the bus.
//
// Registration (sessionstart.mjs / mcp.mjs) tells the hub a session was BORN; nothing
// tells it the session is still ALIVE. So presence decays after RELAY_ONLINE_MS (5 min)
// and the dashboard rots into a graveyard of "idle" boards even while sessions work —
// worst right after the laptop wakes from sleep, when every lastSeen is stale at once and
// there is no resume event to re-register. This hook fixes that: every tool call (a true
// sign of life) refreshes lastSeen, throttled so we hit the hub at most once per window.
// The first tool call after a wake re-greens the session — that first action IS the resume signal.
//
// Cheap + fail-silent by contract: a per-session stamp file gates the network call to once
// per HEARTBEAT_MS, and a short fetch timeout means we never add real latency to a tool call.
// We POST /register WITHOUT a status field so the session's meaningful status is preserved
// (the hub only overwrites status when one is supplied).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir, hostname } from "node:os";

const HEARTBEAT_MS = Number(process.env.RELAY_HEARTBEAT_MS || 60 * 1000);
const FETCH_TIMEOUT_MS = Number(process.env.RELAY_HEARTBEAT_TIMEOUT_MS || 1500);

function relayUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL;
  try {
    const cfg = join(homedir(), ".agent-bus", "config.json");
    if (existsSync(cfg)) { const u = JSON.parse(readFileSync(cfg, "utf8")).url; if (u) return u; }
  } catch {}
  return "http://127.0.0.1:4477";
}

async function main() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // Mirror sessionstart.mjs: home-directory sessions aren't project work — don't register
  // them (would spawn a phantom "<username>" board). Opt in with RELAY_SESSION/RELAY_PROJECT.
  if (!process.env.RELAY_SESSION && !process.env.RELAY_PROJECT && projectDir === homedir()) return;

  // Mirror mcp.mjs identity resolution EXACTLY so we refresh the same peer the relay
  // registered (not a phantom): RELAY_PROJECT wins for project; RELAY_SESSION wins for
  // identity, else a RELAY_AGENT brand ("codex","kimi",…) per project, else hostname:project.
  const project = process.env.RELAY_PROJECT || basename(projectDir);
  const session = process.env.RELAY_SESSION
    || (process.env.RELAY_AGENT ? `${process.env.RELAY_AGENT}:${project}` : `${hostname()}:${project}`);

  // Throttle: only ping if HEARTBEAT_MS has elapsed since the last ping for THIS session.
  const stamp = join(homedir(), ".agent-bus", `hb-${session.replace(/[^A-Za-z0-9_.-]/g, "_")}.stamp`);
  try {
    if (existsSync(stamp)) {
      const last = Number(readFileSync(stamp, "utf8")) || 0;
      if (Date.now() - last < HEARTBEAT_MS) return;   // within window — nothing to do
    }
  } catch {}
  // Write the stamp BEFORE the network call so rapid concurrent tool calls don't all fire.
  try { writeFileSync(stamp, String(Date.now())); } catch {}

  // POST /register with no status -> hub refreshes lastSeen + project, preserves status.
  try {
    await fetch(`${relayUrl()}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session, project }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {}
}

// Never block or break the tool flow: swallow everything, always exit clean.
main().catch(() => {}).finally(() => process.exit(0));

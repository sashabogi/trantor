#!/usr/bin/env node
// trantor PostToolUse heartbeat — Kimi Code port. Every tool call (a true sign of life) refreshes
// the session's lastSeen on the bus, throttled to once per HEARTBEAT_MS; the first tool call after
// a wake re-greens the session. Also carries the proactive context-pressure early-warning: when the
// live occupancy crosses the warn fraction of a DECLARED window (env RELAY_CONTEXT_WINDOW /
// config.contextWindow — Kimi's wire doesn't encode it), hand off BEFORE the compaction wall via a
// detached worker. Without a discovered wire.jsonl or a declared window this is a presence ping only;
// PreCompact remains the at-the-wall backstop. Cheap + fail-silent by contract.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { readPayload, payloadCwd, isHomeSession, identity, relayUrl, debugHook } from "./lib/common.mjs";
import { readConfig, contextUsage, warnFrac, alreadyHandedOff, markHandedOff, controllingTty, terminalWindowForTty, subagentsActive, findWire } from "./lib/handoff.mjs";
import { installedVersion } from "../../hooks/lib/update-check.mjs";

const HEARTBEAT_MS = Number(process.env.RELAY_HEARTBEAT_MS || 60 * 1000);
const FETCH_TIMEOUT_MS = Number(process.env.RELAY_HEARTBEAT_TIMEOUT_MS || 1500);
const INFLIGHT_MS = 5 * 60 * 1000;
const HERE = dirname(fileURLToPath(import.meta.url));

// Proactive early-warning (see the Claude port for the full rationale). The heavy summary runs in
// a detached worker so we never block this tool call. No-op when the window is unknown.
async function maybeEarlyWarn(payload, session, projectDir) {
  try {
    const conf = readConfig();
    const sessionId = String(payload.session_id || "");
    const transcript = String(payload.transcript_path || "") || findWire(projectDir, sessionId);
    if (!transcript) return;
    const usage = contextUsage(transcript, conf);
    if (!usage || !usage.window || usage.frac == null) return;   // window unknown → only PreCompact guards
    if (usage.frac < warnFrac(conf)) return;
    if (alreadyHandedOff(sessionId, usage.tokens)) return;

    // Mid-build guard: never fire an auto baton-pass while sub-agents are actively running.
    if (subagentsActive(transcript)) {
      process.stderr.write(`[trantor] context ${Math.round(usage.frac * 100)}% but sub-agents active — deferring baton pass\n`);
      return;
    }

    // In-flight guard: the detached worker takes ~tens of seconds to summarize.
    const inflight = join(homedir(), ".agent-bus", `handoff-inflight-${String(sessionId).replace(/[^A-Za-z0-9_.-]/g, "_")}.stamp`);
    try { if (existsSync(inflight) && Date.now() - (Number(readFileSync(inflight, "utf8")) || 0) < INFLIGHT_MS) return; } catch {}
    try { writeFileSync(inflight, String(Date.now())); } catch {}

    // Detect THIS session's Terminal window NOW (the detached worker won't have the tty).
    const tty = controllingTty();
    const windowId = tty ? terminalWindowForTty(tty) : "";
    process.stderr.write(`[trantor] context ${Math.round(usage.frac * 100)}% of ${usage.window} — baton pass (window ${windowId || "?"})\n`);
    const child = spawn(process.execPath, [join(HERE, "handoff-now.mjs"), projectDir, sessionId, transcript, "context-warn", windowId, tty],
      { detached: true, stdio: "ignore" });
    child.unref();
    // Persistent per-window guard — exactly ONE baton per context window (re-arms after a reset).
    markHandedOff(sessionId, usage.tokens);
  } catch {}
}

async function main(payload) {
  const projectDir = payloadCwd(payload);
  if (isHomeSession(projectDir)) return;

  const { project, session } = identity(projectDir);

  // Throttle: only act if HEARTBEAT_MS has elapsed since the last tick for THIS session.
  const stamp = join(homedir(), ".agent-bus", `hb-${session.replace(/[^A-Za-z0-9_.-]/g, "_")}.stamp`);
  try {
    if (existsSync(stamp)) {
      const last = Number(readFileSync(stamp, "utf8")) || 0;
      if (Date.now() - last < HEARTBEAT_MS) return;
    }
  } catch {}
  // Write the stamp BEFORE the network call so rapid concurrent tool calls don't all fire.
  try { writeFileSync(stamp, String(Date.now())); } catch {}

  // POST /register with no status -> hub refreshes lastSeen + project, preserves status.
  try {
    await fetch(`${relayUrl()}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session, project, hookVersion: (() => { try { return installedVersion(); } catch { return ""; } })() }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {}

  // Same cadence: check context pressure and hand off early if we've crossed the warn threshold.
  await maybeEarlyWarn(payload, session, projectDir);
}

readPayload()
  .then(p => { debugHook("PostToolUse:heartbeat", p); return main(p); })
  .catch(() => {})
  .finally(() => process.exit(0));

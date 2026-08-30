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
import { readFileSync, writeFileSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir, hostname } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { armBaton, readArm, clearArm, readConfig, contextUsage, warnFrac, alreadyHandedOff, markHandedOff, controllingTty, terminalWindowForTty, subagentsActive } from "./lib/handoff.mjs";
import { resolveProject, hostId } from "../lib/project.mjs";
import { installedVersion } from "./lib/update-check.mjs";   // report our hook version so the hub can flag stale sessions
import { signedPost } from "./lib/api.mjs";

const HEARTBEAT_MS = Number(process.env.RELAY_HEARTBEAT_MS || 60 * 1000);
const FETCH_TIMEOUT_MS = Number(process.env.RELAY_HEARTBEAT_TIMEOUT_MS || 1500);
const ARM_MAX_MS = Number(process.env.TRANTOR_BATON_ARM_MAX_MS || 15 * 60 * 1000);
const INFLIGHT_MS = 5 * 60 * 1000;
const HERE = dirname(fileURLToPath(import.meta.url));

// The model this session is ACTUALLY running, read from the transcript tail — the harness does not
// hand hooks a model field, but every assistant entry records one. Tail-read only (transcripts grow
// to MBs); any failure returns "" and the peer simply keeps its last known model.
function modelFromTranscript(stdinRaw) {
  try {
    const tp = JSON.parse(stdinRaw || "{}").transcript_path;
    if (!tp || !existsSync(tp)) return "";
    const size = statSync(tp).size, want = Math.min(size, 65536);
    const f = openSync(tp, "r");
    try {
      const buf = Buffer.alloc(want);
      readSync(f, buf, 0, want, size - want);
      const m = [...buf.toString("utf8").matchAll(/"model"\s*:\s*"([^"]+)"/g)]
        .map(x => x[1]).filter(v => v.startsWith("claude"));
      return m.length ? m[m.length - 1] : "";
    } finally { closeSync(f); }
  } catch { return ""; }
}


function readStdin() {
  return new Promise(res => { let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => (d += c)); process.stdin.on("end", () => res(d));
    setTimeout(() => res(d), 80); });
}

// Proactive early-warning: when the live context occupancy crosses the warn
// fraction of a KNOWN window (env RELAY_CONTEXT_WINDOW / config.contextWindow —
// the transcript can't reveal 200k vs 1M, so it must be declared), hand off
// BEFORE the compaction wall. The heavy summary runs in a detached worker so we
// never block this tool call. No-op when the window is unknown.
async function maybeEarlyWarn(stdinRaw, session) {
  try {
    const conf = readConfig();
    const input = JSON.parse(stdinRaw || "{}");
    const transcript = input.transcript_path || "";
    const sessionId = input.session_id || "";
    if (!transcript) return;
    const usage = contextUsage(transcript, conf);
    if (!usage || !usage.window || usage.frac == null) return; // window unknown → only PreCompact guards
    if (usage.frac < warnFrac(conf)) return;
    if (alreadyHandedOff(sessionId, usage.tokens)) return;

    // Mid-build guard (incident 2026-06-21): never fire an auto baton-pass while this session is
    // actively orchestrating sub-agents — popping a fresh window (or, before the fix, killing the
    // original) mid 2-agent build is exactly the failure we must prevent. Defer: the next heartbeat
    // re-checks once the agents finish, and PreCompact remains the at-the-wall backstop. We do NOT
    // markHandedOff here, so the baton genuinely retries later instead of being silently skipped.
    if (subagentsActive(transcript)) {
      process.stderr.write(`[trantor] context ${Math.round(usage.frac * 100)}% but sub-agents active — deferring baton pass\n`);
      return;
    }

    // In-flight guard: the detached worker takes ~tens of seconds to summarize;
    // don't launch a second one on the next heartbeat tick meanwhile.
    // NOTE the ordering: this debounce guards the SPAWN, not the arming. It used to sit here and
    // return before any of the logic below, which meant the arm/backstop path never ran a second
    // time and a session that reached no turn boundary would stay armed forever. Arming is cheap
    // and idempotent; only launching the worker needs debouncing.
    const inflight = join(homedir(), ".agent-bus", `handoff-inflight-${String(sessionId).replace(/[^A-Za-z0-9_.-]/g, "_")}.stamp`);
    const spawnDebounced = () => {
      try { if (existsSync(inflight) && Date.now() - (Number(readFileSync(inflight, "utf8")) || 0) < INFLIGHT_MS) return false; } catch {}
      try { writeFileSync(inflight, String(Date.now())); } catch {}
      return true;
    };

    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    // The baton dial (#5509 W2, SYSTEM-CONTRACT §5): "ask" (default) means the OPERATOR fires
    // handoffs — the app's banner asks at this same threshold, and this hook neither arms nor
    // auto-fires. "auto" restores the arm-here → fire-at-Stop chain below. PreCompact remains
    // the at-the-wall backstop in both modes.
    const { resolveAutonomy } = await import("../lib/autonomy.mjs");
    if (resolveAutonomy(resolveProject(projectDir)).baton !== "auto") {
      process.stderr.write(`[trantor] context ${Math.round(usage.frac * 100)}% — baton dial is 'ask': the banner offers, nothing auto-fires\n`);
      return;
    }
    // Detect THIS session's Terminal window NOW (the hook has the controlling tty; the detached worker
    // won't) so the baton-close can replace this exact window once the fresh session takes over.
    const tty = controllingTty();
    const windowId = tty ? terminalWindowForTty(tty) : "";
    // ARM, do not fire. This hook is PostToolUse: the only moment it can ever run is between two
    // tool calls, i.e. mid-turn. Firing here produced a handoff written 36 seconds before the work
    // it described was committed (2026-08-24), and the successor reported four finished things as
    // still open. The Stop hook fires it at the next turn boundary, where the turn is complete.
    //
    // The window id and tty are captured HERE on purpose: this hook has the controlling tty and the
    // detached worker does not, so the baton-close can still replace this exact window later.
    const armed = readArm(sessionId);
    const age = armed ? Date.now() - (Number(armed.ts) || 0) : 0;
    if (armed && age < ARM_MAX_MS) {
      process.stderr.write(`[trantor] context ${Math.round(usage.frac * 100)}% — baton already armed ${Math.round(age / 1000)}s ago, waiting for a turn boundary\n`);
      return;
    }
    if (armed) {
      // Backstop: a session that never reaches a Stop (parked, or looping without ending a turn)
      // must still hand off rather than never. Fire it directly and say that is what happened.
      process.stderr.write(`[trantor] baton armed ${Math.round(age / 60000)}m ago with no turn boundary — firing anyway\n`);
      clearArm(sessionId);
      if (spawnDebounced()) {
        const child = spawn(process.execPath, [join(HERE, "handoff-now.mjs"), projectDir, sessionId, transcript, "context-warn", windowId, tty],
          { detached: true, stdio: "ignore" });
        child.unref();
        markHandedOff(sessionId, usage.tokens);
      }
      return;
    }
    process.stderr.write(`[trantor] context ${Math.round(usage.frac * 100)}% of ${usage.window} — arming the baton for the next turn boundary (window ${windowId || "?"})\n`);
    // Arming does NOT markHandedOff. That guard exists so a session parked above the warn line does
    // not re-fire every tick (8 stacked handoffs ~5 min apart, once observed) — but it makes
    // alreadyHandedOff() short-circuit this whole block, so marking at ARM time meant no later
    // heartbeat could ever run the backstop and a session that reached no Stop stayed armed
    // forever. It is marked where the baton actually fires: here on the backstop path, and in the
    // Stop hook on the normal path. Re-arming every tick is prevented by the age check above.
    armBaton(sessionId, { projectDir, transcript, reason: "context-warn", windowId, tty, tokens: usage.tokens });
  } catch {}
}

async function main(stdinRaw) {
  // input.cwd FIRST — every hook must derive the project the SAME way, or two hooks in one
  // session resolve two projects, two hubs, and half the work records where nobody reads.
  let _in = {}; try { _in = JSON.parse(stdinRaw || "{}"); } catch {}
  const projectDir = _in.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // Mirror sessionstart.mjs: home-directory sessions aren't project work — don't register
  // them (would spawn a phantom "<username>" board). Opt in with RELAY_SESSION/RELAY_PROJECT.
  if (!process.env.RELAY_SESSION && !process.env.RELAY_PROJECT && projectDir === homedir()) return;

  // Mirror mcp.mjs identity resolution EXACTLY so we refresh the same peer the relay
  // registered (not a phantom): RELAY_PROJECT wins for project; RELAY_SESSION wins for
  // identity, else a RELAY_AGENT brand ("codex","kimi",…) per project, else hostname:project.
  const project = resolveProject(projectDir);
  const session = process.env.RELAY_SESSION
    || (process.env.RELAY_AGENT ? `${process.env.RELAY_AGENT}:${project}` : `${hostId()}:${project}`);

  // Throttle: only act if HEARTBEAT_MS has elapsed since the last tick for THIS session.
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
  // llm from the seat brand when a dialect bridge runs us (RELAY_AGENT=kimi-orch etc.), else claude.
  await signedPost("/register", { session, project,
    llm: process.env.RELAY_LLM || (process.env.RELAY_AGENT ? process.env.RELAY_AGENT.replace(/-orch$/, "") : "claude"),
    model: modelFromTranscript(stdinRaw),
    hookVersion: (() => { try { return installedVersion(); } catch { return ""; } })() }, { session, timeoutMs: Number(process.env.RELAY_HEARTBEAT_TIMEOUT_MS || 1500) });

  // Ambient narratives: once an hour (machine-wide stamp), spawn the summarizer detached — the
  // board's machine-titled cards gain a plain-language "assigned — did" line without anyone asking.
  try {
    const sumStamp = join(homedir(), ".agent-bus", "summarize.stamp");
    const last = existsSync(sumStamp) ? Number(readFileSync(sumStamp, "utf8")) || 0 : 0;
    if (Date.now() - last > 60 * 60 * 1000) {
      writeFileSync(sumStamp, String(Date.now()));
      const worker = spawn(process.execPath, [join(HERE, "..", "bin", "summarize.mjs"), "--quiet"], {
        detached: true, stdio: "ignore",
      });
      worker.unref();
    }
  } catch {}

  // Overseer narration, same ambient pattern (10-min machine-wide stamp): the narrate worker was
  // built "to run ambiently from the heartbeat" but was never actually wired in — warns sat
  // mechanical forever unless someone ran it by hand. The worker exits in one cheap signed GET per
  // hub when nothing is unnarrated; Scrooge is only invoked when there IS a warn to explain.
  try {
    const narStamp = join(homedir(), ".agent-bus", "narrate.stamp");
    const last = existsSync(narStamp) ? Number(readFileSync(narStamp, "utf8")) || 0 : 0;
    if (Date.now() - last > 10 * 60 * 1000) {
      writeFileSync(narStamp, String(Date.now()));
      const worker = spawn(process.execPath, [join(HERE, "..", "bin", "overseer-narrate.mjs"), "--quiet"], {
        detached: true, stdio: "ignore",
      });
      worker.unref();
    }
  } catch {}

  // Same cadence as the presence ping: check context pressure and hand off early
  // if we've crossed the warn threshold of a known window.
  await maybeEarlyWarn(stdinRaw, session);
}

// Never block or break the tool flow: swallow everything, always exit clean.
readStdin().then(main).catch(() => {}).finally(() => process.exit(0));

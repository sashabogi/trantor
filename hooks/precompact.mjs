#!/usr/bin/env node
// trantor PreCompact hook — cannot stop compaction, so it writes a whole-session handoff and (macOS,
// by default) prompts to open a FRESH session that takes over; the at-the-wall backstop behind
// the heartbeat's early warning (hooks/lib/handoff.mjs).
import { readConfig, writeHandoff, pingBus, maybeSpawn, armBatonClose,
         contextUsage, alreadyHandedOff, markHandedOff, controllingTty, terminalWindowForTty } from "./lib/handoff.mjs";
import { basename } from "node:path";

function readStdin() {
  return new Promise(res => { let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => (d += c)); process.stdin.on("end", () => res(d));
    setTimeout(() => res(d), 100); });
}

try {
  const input = JSON.parse((await readStdin()) || "{}");
  // input.cwd FIRST — every hook must derive the project the SAME way, or two hooks in one
  // session resolve two projects, two hubs, and half the work records where nobody reads.
  const projectDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const projectName = basename(projectDir);
  const transcript = input.transcript_path || "";
  const trigger = input.trigger || "auto";
  const sessionId = input.session_id || "";
  const conf = readConfig();

  const { file, record } = writeHandoff({ projectDir, sessionId, transcript, trigger, force: true });   // at-wall backstop — must never be storm-guard-suppressed
  process.stderr.write(`[trantor] handoff written: ${file} (trigger=${trigger})\n`);

  await pingBus(projectName, record.id, conf);

  // Spawn a fresh session UNLESS the heartbeat early-warning already did so for this
  // window (shared guard). The handoff file is always refreshed above regardless.
  const cur = contextUsage(transcript, conf)?.tokens || 0;
  if (alreadyHandedOff(sessionId, cur)) {
    process.stderr.write(`[trantor] fresh session already spawned for this window — handoff refreshed only\n`);
  } else if (maybeSpawn(projectDir, conf)) {
    markHandedOff(sessionId, cur);
    // baton pass at the wall. Close THIS window ONLY when config.autoCloseOriginal is true: an auto
    // baton must never kill a session. The controlling tty is available here for that case.
    const tty = controllingTty();
    const windowId = tty ? terminalWindowForTty(tty) : "";
    const armed = windowId ? armBatonClose(file, windowId, tty, conf, { auto: true }) : false;
    process.stderr.write(`[trantor] fresh-session spawned (PreCompact)${armed ? ` · baton-close armed for window ${windowId}` : " · original window left alive (auto-close off by default)"}\n`);
  }
} catch (err) {
  process.stderr.write(`[trantor] precompact error: ${err?.message || err}\n`);
}
process.stdout.write("{}");
process.exit(0);

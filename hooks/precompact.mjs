#!/usr/bin/env node
// trantor PreCompact hook — fires right before Claude Code compacts a full context
// window. A PreCompact hook CANNOT stop compaction; the current window is always
// compacted. So its job is to write a rich WHOLE-SESSION handoff and (on macOS, by
// default) prompt to open a FRESH session in a new terminal that takes over with a
// full window. The new session's SessionStart hook loads the handoff. This is the
// at-the-wall backstop; the heartbeat hook can also fire this earlier when the
// context window size is known (see hooks/lib/handoff.mjs).
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
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const projectName = basename(projectDir);
  const transcript = input.transcript_path || "";
  const trigger = input.trigger || "auto";
  const sessionId = input.session_id || "";
  const conf = readConfig();

  const { file, record } = writeHandoff({ projectDir, sessionId, transcript, trigger });
  process.stderr.write(`[trantor] handoff written: ${file} (trigger=${trigger})\n`);

  await pingBus(projectName, record.id, conf);

  // Spawn a fresh session UNLESS the heartbeat early-warning already did so for this
  // window (shared guard). The handoff file is always refreshed above regardless.
  const cur = contextUsage(transcript, conf)?.tokens || 0;
  if (alreadyHandedOff(sessionId, cur)) {
    process.stderr.write(`[trantor] fresh session already spawned for this window — handoff refreshed only\n`);
  } else if (maybeSpawn(projectDir, conf)) {
    markHandedOff(sessionId, cur);
    // baton pass: at-the-wall fresh session. Close THIS window ONLY if opted in
    // (config.autoCloseOriginal:true) — default leaves the original alive (2026-06-21 fix: an auto
    // baton must never kill a session). We have the controlling tty here for the opt-in case.
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

#!/usr/bin/env node
// trantor PreCompact hook — Kimi Code port. Fires right before Kimi Code compacts the context
// window. A PreCompact hook CANNOT stop compaction; its job is to write a rich WHOLE-SESSION
// handoff and (on macOS, by default) prompt to open a FRESH `kimi` session in a new terminal that
// takes over with a full window — the new session's SessionStart hook loads the handoff. This is
// the at-the-wall backstop; the heartbeat early-warning can fire it earlier when the context
// window size is declared (RELAY_CONTEXT_WINDOW / config.contextWindow).
import { readConfig, writeHandoff, pingBus, maybeSpawn, armBatonClose, contextUsage, alreadyHandedOff, markHandedOff, controllingTty, terminalWindowForTty, findWire } from "./lib/handoff.mjs";
import { readPayload, payloadCwd, debugHook } from "./lib/common.mjs";
import { basename } from "node:path";

try {
  const payload = await readPayload();
  debugHook("PreCompact", payload);
  const projectDir = payloadCwd(payload);
  if (!projectDir) { process.stderr.write("[trantor] kimi precompact: no project cwd in payload — skipping\n"); process.exit(0); }
  const projectName = basename(projectDir);
  const sessionId = String(payload.session_id || "");
  const transcript = String(payload.transcript_path || "") || findWire(projectDir, sessionId);
  const trigger = String(payload.trigger || payload.reason || "auto");
  const conf = readConfig();

  const { file, record } = writeHandoff({ projectDir, sessionId, transcript, trigger, force: true });   // at-wall backstop — never storm-guard-suppressed
  process.stderr.write(`[trantor] handoff written: ${file} (trigger=${trigger})\n`);

  await pingBus(projectName, record.id, conf);

  // Spawn a fresh session UNLESS the heartbeat early-warning already did so for this window.
  const cur = contextUsage(transcript, conf)?.tokens || 0;
  if (alreadyHandedOff(sessionId, cur)) {
    process.stderr.write(`[trantor] fresh session already spawned for this window — handoff refreshed only\n`);
  } else if (maybeSpawn(projectDir, conf)) {
    markHandedOff(sessionId, cur);
    // baton pass: at-the-wall fresh session. Close THIS window ONLY if opted in
    // (config.autoCloseOriginal:true) — default leaves the original alive.
    const tty = controllingTty();
    const windowId = tty ? terminalWindowForTty(tty) : "";
    const armed = windowId ? armBatonClose(file, windowId, tty, conf, { auto: true }) : false;
    process.stderr.write(`[trantor] fresh-session spawned (PreCompact)${armed ? ` · baton-close armed for window ${windowId}` : " · original window left alive (auto-close off by default)"}\n`);
  }
} catch (err) {
  process.stderr.write(`[trantor] kimi precompact error: ${err?.message || err}\n`);
}
process.exit(0);

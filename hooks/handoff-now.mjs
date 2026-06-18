#!/usr/bin/env node
// trantor — detached EARLY-WARNING handoff worker. The PostToolUse heartbeat spawns this when a
// session crosses its context warn threshold (~85% of a known window). Its job is to PREPARE a
// safety-net handoff and NOTIFY — NOT to open a window. Spawning a fresh session while the original
// is still perfectly usable created a surprise pop-up + an orphaned duplicate session; the actual
// fresh-window spawn now happens only AT THE WALL (PreCompact). The (~60s) scrooge summary runs here,
// detached, so it never blocks a tool call. Args: <projectDir> <sessionId> <transcriptPath> [trigger]
import { readConfig, writeHandoff, pingBus, contextUsage } from "./lib/handoff.mjs";
import { basename } from "node:path";

const [, , projectDir = process.cwd(), sessionId = "", transcript = "", trigger = "context-warn"] = process.argv;
try {
  const conf = readConfig();
  const { file, record } = writeHandoff({ projectDir, sessionId, transcript, trigger });
  process.stderr.write(`[trantor] early handoff written (safety net, no spawn): ${file}\n`);
  // notify the bus so a watcher knows a handoff is ready — but do NOT spawn a window here.
  await pingBus(basename(projectDir), record.id, conf);
} catch (e) {
  process.stderr.write(`[trantor] handoff-now error: ${e?.message || e}\n`);
}
process.exit(0);

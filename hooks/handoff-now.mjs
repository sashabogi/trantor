#!/usr/bin/env node
// trantor — detached handoff worker. The PostToolUse heartbeat spawns this when a
// session crosses its context warn threshold, so the (up to ~60s) scrooge summary
// never blocks a tool call. Writes a whole-session handoff and prompts to open a
// fresh session. Args: <projectDir> <sessionId> <transcriptPath> [trigger]
import { readConfig, writeHandoff, pingBus, maybeSpawn,
         contextUsage, alreadyHandedOff, markHandedOff } from "./lib/handoff.mjs";
import { basename } from "node:path";

const [, , projectDir = process.cwd(), sessionId = "", transcript = "", trigger = "context-warn"] = process.argv;
try {
  const conf = readConfig();
  const cur = contextUsage(transcript, conf)?.tokens || 0;
  if (alreadyHandedOff(sessionId, cur)) process.exit(0); // another path beat us to it
  const { file, record } = writeHandoff({ projectDir, sessionId, transcript, trigger });
  process.stderr.write(`[trantor] early handoff written: ${file} (frac warn)\n`);
  await pingBus(basename(projectDir), record.id, conf);
  if (maybeSpawn(projectDir, conf)) markHandedOff(sessionId, cur);
} catch (e) {
  process.stderr.write(`[trantor] handoff-now error: ${e?.message || e}\n`);
}
process.exit(0);

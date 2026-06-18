#!/usr/bin/env node
// trantor — detached BATON-PASS worker. The PostToolUse heartbeat spawns this when a session crosses
// its context warn threshold (~90% of a known window). It writes a whole-session handoff (narrative +
// verbatim in-flight tail), spawns a FRESH session to take over, and arms the baton-close watcher which
// — once the fresh session has consumed the handoff — closes THIS (original) session's Terminal window.
// The heavy scrooge summary runs here, detached, so it never blocks a tool call. The original's window
// id + tty are detected by the heartbeat (which has the controlling tty) and passed in as args.
// Args: <projectDir> <sessionId> <transcriptPath> [trigger] [originalWindowId] [originalTty]
import { readConfig, writeHandoff, pingBus, maybeSpawn, armBatonClose } from "./lib/handoff.mjs";
import { basename } from "node:path";

const [, , projectDir = process.cwd(), sessionId = "", transcript = "", trigger = "context-warn", windowId = "", tty = ""] = process.argv;
try {
  const conf = readConfig();
  const { file, record } = writeHandoff({ projectDir, sessionId, transcript, trigger });
  process.stderr.write(`[trantor] baton handoff written: ${file}\n`);
  await pingBus(basename(projectDir), record.id, conf);
  if (maybeSpawn(projectDir, conf)) {                 // open the fresh session that takes over
    const armed = windowId ? armBatonClose(file, windowId, tty, conf) : false;  // close the original once fresh confirms
    process.stderr.write(`[trantor] fresh session spawned${armed ? ` · baton-close armed for window ${windowId}` : " · no original-window close (none detected / disabled)"}\n`);
  }
} catch (e) {
  process.stderr.write(`[trantor] handoff-now error: ${e?.message || e}\n`);
}
process.exit(0);

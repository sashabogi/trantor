#!/usr/bin/env node
// trantor — detached BATON-PASS worker (Kimi Code port). The PostToolUse heartbeat spawns this
// when a session crosses its context warn threshold (~90% of a declared window). It writes a
// whole-session handoff (scrooge narrative + verbatim in-flight tail), spawns a FRESH `kimi`
// session to take over, and arms the baton-close watcher which — once the fresh session has
// consumed the handoff — closes THIS (original) session's Terminal window (opt-in only).
// Args: <projectDir> <sessionId> <transcriptPath> [trigger] [originalWindowId] [originalTty]
import { readConfig, writeHandoff, pingBus, maybeSpawn, armBatonClose } from "./lib/handoff.mjs";
import { basename } from "node:path";

const [, , projectDir = "", sessionId = "", transcript = "", trigger = "context-warn", windowId = "", tty = ""] = process.argv;
try {
  if (!projectDir) process.exit(0);
  const conf = readConfig();
  const result = writeHandoff({ projectDir, sessionId, transcript, trigger });   // auto path — honors the hub storm guard
  if (result.skipped) { process.stderr.write(`[trantor] handoff SKIPPED by storm-guard (${result.reason}; ${result.sinceSec ?? "?"}s since last) — no fresh window spawned\n`); process.exit(0); }
  const { file, record } = result;
  process.stderr.write(`[trantor] baton handoff written: ${file}\n`);
  await pingBus(basename(projectDir), record.id, conf);
  if (maybeSpawn(projectDir, conf)) {
    // AUTO baton: close the original ONLY if explicitly opted in (config.autoCloseOriginal:true).
    const armed = windowId ? armBatonClose(file, windowId, tty, conf, { auto: true }) : false;
    process.stderr.write(`[trantor] fresh session spawned${armed ? ` · baton-close armed for window ${windowId}` : " · original window left alive (auto-close off by default)"}\n`);
  }
} catch (e) {
  process.stderr.write(`[trantor] kimi handoff-now error: ${e?.message || e}\n`);
}
process.exit(0);

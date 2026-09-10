#!/usr/bin/env node
// trantor detached BATON-PASS worker, spawned by the heartbeat past the warn threshold: writes a
// whole-session handoff, spawns a fresh session, arms baton-close. Heavy work runs here so no
// tool call blocks. Args: <projectDir> <sessionId> <transcriptPath> [trigger] [windowId] [tty]
import { readConfig, writeHandoff, pingBus, maybeSpawn, armBatonClose } from "./lib/handoff.mjs";
import { basename } from "node:path";

const [, , projectDir = process.cwd(), sessionId = "", transcript = "", trigger = "context-warn", windowId = "", tty = ""] = process.argv;
try {
  const conf = readConfig();
  const result = writeHandoff({ projectDir, sessionId, transcript, trigger });   // auto path — honors the hub storm guard
  if (result.skipped) { process.stderr.write(`[trantor] handoff SKIPPED by storm-guard (${result.reason}; ${result.sinceSec ?? "?"}s since last) — no fresh window spawned\n`); process.exit(0); }
  const { file, record } = result;
  process.stderr.write(`[trantor] baton handoff written: ${file}\n`);
  await pingBus(basename(projectDir), record.id, conf);
  if (maybeSpawn(projectDir, conf)) {                 // open the fresh session that takes over
    // AUTO baton: close the original ONLY when opted in (config.autoCloseOriginal:true); an
    // auto-close must never kill an in-flight session.
    const armed = windowId ? armBatonClose(file, windowId, tty, conf, { auto: true }) : false;
    process.stderr.write(`[trantor] fresh session spawned${armed ? ` · baton-close armed for window ${windowId}` : " · original window left alive (auto-close off by default)"}\n`);
  }
} catch (e) {
  process.stderr.write(`[trantor] handoff-now error: ${e?.message || e}\n`);
}
process.exit(0);

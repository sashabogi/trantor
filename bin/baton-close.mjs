#!/usr/bin/env node
// trantor baton-close — the second half of the baton pass. Runs DETACHED, armed by the handoff hook.
// Waits until the FRESH session has consumed the handoff (consumed:true on the handoff file = it
// started and loaded the context), THEN closes the ORIGINAL session's Terminal window — so you're never
// left with two live sessions on one project, and never a gap where neither is alive. Defensive: aborts
// if the fresh session never shows (timeout), and re-validates the window's tty before closing so it can
// NEVER close the wrong window. Args: <handoffFile> <originalWindowId> <originalTty>
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const [, , handoffFile, windowId, originalTty] = process.argv;
const POLL_MS = 1500, TIMEOUT_MS = 120_000;

const consumed = () => { try { return JSON.parse(readFileSync(handoffFile, "utf8")).consumed === true; } catch { return false; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ttyOfWindow(id) {
  try {
    return execSync(`osascript -e ${JSON.stringify(`tell application "Terminal" to get tty of selected tab of (first window whose id is ${id})`)}`,
      { encoding: "utf8", timeout: 3000 }).trim();
  } catch { return ""; }
}
function closeWindow(id, tty) {
  // re-validate: only close if the window is STILL on the original tty (never close a re-used/wrong window)
  const cur = ttyOfWindow(id);
  if (!cur || (originalTty && cur !== originalTty)) {
    process.stderr.write(`[trantor] baton-close: window ${id} tty changed (${cur} != ${originalTty}) — NOT closing\n`);
    return false;
  }
  try {
    // SIGKILL the processes on that tty first (claude traps SIGTERM; a live login makes close() pop a dialog)
    const dev = (tty || cur).replace(/^\/dev\//, "");
    for (const pid of execSync(`ps -t ${dev} -o pid= 2>/dev/null || true`, { encoding: "utf8" }).trim().split("\n").filter(Boolean)) {
      try { execSync(`kill -9 ${pid.trim()} 2>/dev/null || true`); } catch {}
    }
  } catch {}
  try { execSync(`osascript -e ${JSON.stringify(`tell application "Terminal" to close (first window whose id is ${id})`)}`, { timeout: 3000 }); return true; } catch { return false; }
}

(async () => {
  if (!handoffFile || !windowId) process.exit(0);
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (consumed()) {
      await sleep(2500); // let the fresh session settle (register, inject) before we pull the original
      const ok = closeWindow(windowId, originalTty);
      process.stderr.write(`[trantor] baton-close: fresh session took over → original window ${windowId} ${ok ? "closed" : "left (validation/close failed)"}\n`);
      process.exit(0);
    }
    await sleep(POLL_MS);
  }
  process.stderr.write(`[trantor] baton-close: fresh session never confirmed within ${TIMEOUT_MS / 1000}s — leaving the original alive (safe)\n`);
  process.exit(0);
})();

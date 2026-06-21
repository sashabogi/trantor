#!/usr/bin/env node
// trantor baton-close — the second half of the baton pass. Runs DETACHED, armed by the handoff hook.
// Waits until the FRESH session has consumed the handoff (consumed:true on the handoff file = it
// started and loaded the context), THEN closes the ORIGINAL session's Terminal window — so you're never
// left with two live sessions on one project, and never a gap where neither is alive. Defensive: aborts
// if the fresh session never shows (timeout), and re-validates the window's tty before closing so it can
// NEVER close the wrong window. Args: <handoffFile> <originalWindowId> <originalTty>
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const [, , handoffFile, windowId, originalTty] = process.argv;
const POLL_MS = 1500, TIMEOUT_MS = 180_000;
// Once the handoff is consumed (= injected into the fresh session's context), wait up to this long for
// the fresh session to actually PRODUCE its first assistant turn (it boots with `claude 'Recap…'`, so it
// genuinely reads the handoff and replies) before we close the original. If the fresh session never
// emits a turn (e.g. it crashed, or a non-recap spawn), we close anyway after this grace so we don't
// leave two windows forever — the handoff is already in its context, so there's no data loss.
const ENGAGE_GRACE_MS = 45_000;

const handoff = () => { try { return JSON.parse(readFileSync(handoffFile, "utf8")); } catch { return null; } };
const consumed = () => handoff()?.consumed === true;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// True once the fresh session's transcript shows an assistant turn at/after the handoff was consumed —
// i.e. the new model has actually read the handoff and started driving (its recap reply). A brand-new
// session's transcript has no prior assistant turns, so the first one to appear IS the takeover.
export function freshEngaged(rec) {
  try {
    const tp = rec?.consumedBy?.transcript_path;
    if (!tp || !existsSync(tp)) return false;
    const consumedAt = Number(rec.consumedAt) || 0;
    const lines = readFileSync(tp, "utf8").split("\n");
    for (const ln of lines) {
      if (!ln) continue;
      let r; try { r = JSON.parse(ln); } catch { continue; }
      if (r?.type !== "assistant") continue;
      const ts = r.timestamp ? Math.floor(Date.parse(r.timestamp) / 1000) : 0;
      if (!consumedAt || !ts || ts >= consumedAt - 5) return true;
    }
    return false;
  } catch { return false; }
}

// Wait for genuine takeover (fresh assistant turn) with a bounded grace. Returns when engaged or grace
// elapsed. If the handoff carries no consumedBy transcript (older record), there's nothing to watch — a
// short settle and proceed, preserving prior behavior.
async function waitForTakeover() {
  const rec = handoff();
  if (!rec?.consumedBy?.transcript_path) { await sleep(2500); return; }
  const until = Date.now() + ENGAGE_GRACE_MS;
  while (Date.now() < until) {
    if (freshEngaged(handoff())) { await sleep(800); return; }  // small settle after the turn lands
    await sleep(POLL_MS);
  }
  process.stderr.write(`[trantor] baton-close: fresh session consumed but produced no turn within ${ENGAGE_GRACE_MS / 1000}s — closing anyway (handoff already injected)\n`);
}

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

// Only run the close watcher when executed directly — importing this file (tests) must not block.
const isMain = (() => { try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; } })();

if (isMain) (async () => {
  if (!handoffFile || !windowId) process.exit(0);
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (consumed()) {
      await waitForTakeover(); // don't close until the fresh session has actually produced its recap turn
      const ok = closeWindow(windowId, originalTty);
      process.stderr.write(`[trantor] baton-close: fresh session took over → original window ${windowId} ${ok ? "closed" : "left (validation/close failed)"}\n`);
      process.exit(0);
    }
    await sleep(POLL_MS);
  }
  process.stderr.write(`[trantor] baton-close: fresh session never confirmed within ${TIMEOUT_MS / 1000}s — leaving the original alive (safe)\n`);
  process.exit(0);
})();

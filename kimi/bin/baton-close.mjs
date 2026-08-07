#!/usr/bin/env node
// trantor/kimi baton-close — the second half of the baton pass, Kimi Code port. Runs DETACHED,
// armed by the handoff hook. Waits until the FRESH session has consumed the handoff (consumed:true
// on the handoff file), THEN closes the ORIGINAL session's Terminal window.
// NON-DESTRUCTIVE by contract (incident 2026-06-21): never force-kills; runs only for opt-in
// auto-close or a manual baton; waits for the fresh session's first real turn (a loop event in its
// wire.jsonl at/after the claim); re-validates the window's tty; ABORTS if the original is still
// working (recent wire activity or live sub-agents). Args: <handoffFile> <originalWindowId> <originalTty>
import { readFileSync, existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { subagentsActive } from "../hooks/lib/handoff.mjs";

const [, , handoffFile, windowId, originalTty] = process.argv;
const POLL_MS = 1500, TIMEOUT_MS = 180_000;
const ORIG_QUIET_MS = 12_000, SUBAGENT_ACTIVE_MS = 90_000;
const ENGAGE_GRACE_MS = 45_000;

const handoff = () => { try { return JSON.parse(readFileSync(handoffFile, "utf8")); } catch { return null; } };
const consumed = () => handoff()?.consumed === true;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// True once the fresh session's wire.jsonl shows activity at/after the handoff was consumed —
// i.e. the new session booted and produced its first turn. Kimi wire timestamps are ms epoch;
// consumedAt is seconds.
export function freshEngaged(rec) {
  try {
    const tp = rec?.consumedBy?.transcript_path;
    if (!tp || !existsSync(tp)) return false;
    const consumedAtMs = (Number(rec.consumedAt) || 0) * 1000;
    const lines = readFileSync(tp, "utf8").split("\n");
    for (const ln of lines) {
      if (!ln) continue;
      let r; try { r = JSON.parse(ln); } catch { continue; }
      if (r?.type !== "context.append_loop_event" && r?.type !== "turn.prompt" && r?.type !== "usage.record") continue;
      const ts = Number(r.time) || 0;
      if (!consumedAtMs || !ts || ts >= consumedAtMs - 5000) return true;
    }
    return false;
  } catch { return false; }
}

async function waitForTakeover() {
  const rec = handoff();
  if (!rec?.consumedBy?.transcript_path) { await sleep(2500); return; }
  const until = Date.now() + ENGAGE_GRACE_MS;
  while (Date.now() < until) {
    if (freshEngaged(handoff())) { await sleep(800); return; }
    await sleep(POLL_MS);
  }
  process.stderr.write(`[trantor] kimi baton-close: fresh session consumed but produced no turn within ${ENGAGE_GRACE_MS / 1000}s — closing anyway (handoff already injected)\n`);
}

// True if the ORIGINAL session is still doing real work — its wire was written very recently or it
// has live sub-agents. We NEVER close a working session.
export function originalStillWorking(rec, { quietMs = ORIG_QUIET_MS, subWithinMs = SUBAGENT_ACTIVE_MS } = {}) {
  try {
    const tp = rec?.transcript_path;
    if (!tp || !existsSync(tp)) return false;
    try { if (Date.now() - statSync(tp).mtimeMs < quietMs) return true; } catch {}
    return subagentsActive(tp, subWithinMs);
  } catch { return false; }
}

function ttyOfWindow(id) {
  try {
    return execSync(`osascript -e ${JSON.stringify(`tell application "Terminal" to get tty of selected tab of (first window whose id is ${id})`)}`,
      { encoding: "utf8", timeout: 3000 }).trim();
  } catch { return ""; }
}
function closeWindow(id, tty) {
  const cur = ttyOfWindow(id);
  if (!cur || (originalTty && cur !== originalTty)) {
    process.stderr.write(`[trantor] kimi baton-close: window ${id} tty changed (${cur} != ${originalTty}) — NOT closing\n`);
    return false;
  }
  try {
    // Gently ask the processes on that tty to exit (SIGTERM — never SIGKILL); only reached once the
    // original is confirmed idle, so kimi exits cleanly.
    const dev = (tty || cur).replace(/^\/dev\//, "");
    for (const pid of execSync(`ps -t ${dev} -o pid= 2>/dev/null || true`, { encoding: "utf8" }).trim().split("\n").filter(Boolean)) {
      try { execSync(`kill -TERM ${pid.trim()} 2>/dev/null || true`); } catch {}
    }
  } catch {}
  try { execSync(`osascript -e ${JSON.stringify(`tell application "Terminal" to close (first window whose id is ${id})`)}`, { timeout: 3000 }); return true; } catch { return false; }
}

const isMain = (() => { try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; } })();

if (isMain) (async () => {
  if (!handoffFile || !windowId) process.exit(0);
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (consumed()) {
      await waitForTakeover();
      if (originalStillWorking(handoff())) {
        process.stderr.write(`[trantor] kimi baton-close: original session still working (recent activity / live sub-agents) — leaving it alive, NOT closing\n`);
        process.exit(0);
      }
      const ok = closeWindow(windowId, originalTty);
      process.stderr.write(`[trantor] kimi baton-close: fresh session took over → original window ${windowId} ${ok ? "closed" : "left (validation/close failed)"}\n`);
      process.exit(0);
    }
    await sleep(POLL_MS);
  }
  process.stderr.write(`[trantor] kimi baton-close: fresh session never confirmed within ${TIMEOUT_MS / 1000}s — leaving the original alive (safe)\n`);
  process.exit(0);
})();

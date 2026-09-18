#!/usr/bin/env node
// Turn watchdog (#5684, #6206, #7752, #7761): runTurn is spawnSync, so this DETACHED helper watches
// the turn — liveness = transcript, worktree or stderr moving; a whole silent window earns ONE stall
// report, and in kill mode (stall file given) also ends the turn via the shell box. Stamp-bound to one runner.
//   node bin/turn-watchdog.mjs <stampFile> <errFile> <windowMs> <session> <project> <hubUrl> <transcriptDir> <workDir> [stallFile]
import { readFileSync, writeFileSync, appendFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hostId } from "../lib/project.mjs";
import { signedPost } from "../hooks/lib/api.mjs";

const [stampFile, errFile, windowMsRaw, session, project, hub, transcriptDir = "", workDir = "", stallFile = ""] = process.argv.slice(2);
// SAFETY: the 10-minute floor lives in crew-runner.mjs (the default when TRANTOR_TURN_WATCHDOG_MS
// is unset); this fallback only covers a missing argument. Drills pass tiny windows on purpose.
const windowMs = Number(windowMsRaw) || 10 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readStamp = () => { try { return JSON.parse(readFileSync(stampFile, "utf8")); } catch { return null; } };
const errSize = () => { try { return statSync(errFile).size; } catch { return 0; } };

// Newest mtime under a directory, .git/node_modules skipped, entry-capped so a big tree cannot
// wedge a detached helper. A missing directory scores 0 (a codex seat has no claude transcript
// dir) — liveness needs only ONE channel to move, absence of some channels is fine.
const SCAN_CAP = 20000;
function newestMtime(dir) {
  let best = 0, seen = 0;
  const walk = (d) => {
    if (seen > SCAN_CAP) return;
    let rows = [];
    try { rows = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of rows) {
      if (++seen > SCAN_CAP || e.name === ".git" || e.name === "node_modules") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { best = Math.max(best, statSync(p).mtimeMs); } catch {} }
    }
  };
  walk(dir);
  return best;
}

const armed = readStamp();
if (!armed) process.exit(0);
// The runner instance that armed us (pid + boot ts, so a recycled pid cannot impersonate it).
// A stamp without a runner id (only possible mid-upgrade) skips the liveness check; the id
// match in the loop still guards it.
const runnerPid = Number(String(armed.runner || "").split(".")[0]) || 0;
const runnerAlive = () => {
  if (!runnerPid) return true;
  try { process.kill(runnerPid, 0); return true; } catch { return false; }
};

// One observation of every liveness channel: stderr growth, transcript mtime, worktree mtime.
const ago = (t) => (t > 0 ? `${Math.max(1, Math.round((Date.now() - t) / 60000))}m ago` : "never");
const describeLast = (b) => {
  const parts = [];
  if (b.wk) parts.push(`worktree ${ago(b.wk)}`);
  if (b.tr) parts.push(`transcript ${ago(b.tr)}`);
  return parts.length ? parts.join(", ") : "nothing";
};
let baseErr = errSize();
const armedAt = armed.startedAt || Date.now();
const SLACK = 2000;   // timestamp granularity + scheduler drift under load

// #7752 kill mode: poll liveness; a whole window silent on EVERY channel writes the stall marker
// (the shell box sweeps on it), reports once, exits; stderr is measured ROLLING (bytes this window).
// #7761: `armed.box` (step, ceiling, assigners) exists only when a ceiling above the box does; a
// deadline one poll away on a turn that moved within the window is pushed out one step.
const box = stallFile && armed.box && Number(armed.box.extensionsMax) > 0 ? armed.box : null;
const mins = (ms) => `${Math.max(1, Math.round(ms / 60000))}m`;
const secsOrMins = (ms) => (ms >= 60000 ? mins(ms) : `${Math.round(ms / 1000)}s`);
async function tellExtension(text) {
  const orch = `${hostId()}:${project}`;
  const seen = new Set();
  for (const a of [...(box.assigners || []), { from: orch }]) {
    const to = String(a?.from || "");
    if (!to || to === "all" || to === session || to.startsWith("hub:") || seen.has(to)) continue;
    seen.add(to);
    try { await signedPost(`${hub}/send`, { from: session, to, text, project, kind: "status", wake: false }, { session }); } catch {}
  }
}

if (stallFile) {
  const poll = Math.max(250, Math.min(windowMs / 4, 10000));
  let lastErrAt = armedAt;
  let deadline = armedAt + (box ? Number(box.maxMs) : 0);
  let extensions = 0;
  for (;;) {
    await sleep(poll);
    const s = readStamp();
    if (!s || s.turn !== armed.turn || (armed.runner && s.runner !== armed.runner)) process.exit(0); // turn ended, or a NEWER runner owns the stamp now
    if (!runnerAlive()) process.exit(0);                       // our runner is gone — never speak for it
    const now = Date.now();
    const size = errSize();
    if (size > baseErr + 200) { baseErr = size; lastErrAt = now; }   // new bytes: alive
    const freshCut = Math.max(armedAt, now - windowMs - SLACK);
    const tr = transcriptDir ? newestMtime(transcriptDir) : 0;
    const wk = workDir ? newestMtime(workDir) : 0;
    if (tr > freshCut || wk > freshCut || now - lastErrAt < windowMs) {           // producing work: alive
      if (box && extensions < Number(box.extensionsMax) && now + poll + SLACK >= deadline) {
        extensions++;
        deadline += Number(box.extendMs);
        try { writeFileSync(box.deadlineFile, String(Math.floor(deadline / 1000))); } catch {}
        try { appendFileSync(box.extFile, JSON.stringify({ n: extensions, at: now, until: deadline }) + "\n"); } catch {}
        const card = Number(box.card) > 0 ? ` on #${box.card}` : "";
        await tellExtension(`⏳ ${session} turn extended +${secsOrMins(Number(box.extendMs))} (${extensions}/${box.extensionsMax})${card} — alive: ${describeLast({ tr, wk })}${now - lastErrAt < windowMs ? ", stderr moving" : ""}; box now ${secsOrMins(deadline - armedAt)} of a ${secsOrMins(Number(box.ceilingMs))} ceiling`);
      }
      continue;
    }
    try { writeFileSync(stallFile, ""); } catch {}
    const mins = Math.round((now - armedAt) / 60000);
    const orch = `${hostId()}:${project}`;
    const text = `⏱ ${session} turn STALLED — ${mins}m with no activity (turn ${s.turn}; last seen: ${describeLast({ tr, wk })}, stderr ${baseErr > 0 ? `${baseErr}B` : "silent"}); ending the turn at the stall window, not the box.`;
    // Direct = wake. The foreman first; if this seat IS the foreman's own runner, say it to all.
    const to = orch === session ? "all" : orch;
    try { await signedPost(`${hub}/send`, { from: session, to, text, project }, { session }); } catch {}
    process.exit(0);                                            // one report per turn, by construction
  }
}

for (;;) {
  await sleep(windowMs);
  const s = readStamp();
  if (!s || s.turn !== armed.turn || (armed.runner && s.runner !== armed.runner)) process.exit(0); // turn ended, or a NEWER runner owns the stamp now
  if (!runnerAlive()) process.exit(0);                       // our runner is gone — never speak for it
  // Activity that counts: anything changed DURING the turn (after arm) and within the window —
  // the checklist semantics verbatim: "no new activity for the window". Pre-turn files never
  // count (they predate arm), and absolute freshness cannot drift the way a probe-to-probe
  // delta does when the seat writes coarsely or the machine loads (the +1130ms false alarm).
  const freshCut = Math.max(armedAt, Date.now() - windowMs - SLACK);
  const tr = transcriptDir ? newestMtime(transcriptDir) : 0;
  const wk = workDir ? newestMtime(workDir) : 0;
  if (errSize() > baseErr + 200 || tr > freshCut || wk > freshCut) continue;   // producing work: alive, re-arm
  const mins = Math.round((Date.now() - armedAt) / 60000);
  const orch = `${hostId()}:${project}`;
  const text = `⏱ ${session} turn STALLED — running ${mins}m with no activity (turn ${s.turn}; last seen: ${describeLast({ tr, wk })}, stderr ${baseErr > 0 ? `${baseErr}B` : "silent"}). Not killed; check its pane, or \`trantor swap\`.`;
  // Direct = wake. The foreman first; if this seat IS the foreman's own runner, say it to all.
  const to = orch === session ? "all" : orch;
  try { await signedPost(`${hub}/send`, { from: session, to, text, project }, { session }); } catch {}
  process.exit(0);                                            // one report per turn, by construction
}

#!/usr/bin/env node
// Turn watchdog (#5684, reworked #6206). runTurn is spawnSync — the runner cannot watch its own
// turn — so this DETACHED helper does: armed at turn start, disarmed by turn end. A turn past
// the window with NO new activity earns ONE direct stall report to the foreman (episode, never a
// timer storm), and the turn is never killed — reporting is the whole job.
//
// #6206: stdout silence is NOT a stall — `claude -p` prints nothing until the turn ends by
// design, so a seat editing five files was reported STALLED while its transcript advanced.
// Liveness is new activity in the seat's transcript (the CLI's session file), its worktree, or
// stderr growth; silence on ALL of them for a whole window is the only thing reported. And a
// watchdog never speaks for a runner it does not belong to: the stamp carries the runner's
// instance id, so a survivor of a replaced runner exits on mismatch or runner death instead of
// re-matching the NEW runner's turn number (the 09:47 false alarm was exactly that orphan).
//
//   node bin/turn-watchdog.mjs <stampFile> <errFile> <windowMs> <session> <project> <hubUrl> <transcriptDir> <workDir>
import { readFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hostId } from "../lib/project.mjs";
import { signedPost } from "../hooks/lib/api.mjs";

const [stampFile, errFile, windowMsRaw, session, project, hub, transcriptDir = "", workDir = ""] = process.argv.slice(2);
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
const probe = () => ({
  err: errSize(),
  tr: transcriptDir ? newestMtime(transcriptDir) : 0,
  wk: workDir ? newestMtime(workDir) : 0,
});
const ago = (t) => (t ? `${Math.max(1, Math.round((Date.now() - t) / 60000))}m ago` : "never");
const describeLast = (b) => {
  const parts = [];
  if (b.wk) parts.push(`worktree ${ago(b.wk)}`);
  if (b.tr) parts.push(`transcript ${ago(b.tr)}`);
  parts.push(b.err > 0 ? `stderr ${b.err}B` : "stderr silent");
  return parts.join(", ");
};
let base = probe();

for (;;) {
  await sleep(windowMs);
  const s = readStamp();
  if (!s || s.turn !== armed.turn || (armed.runner && s.runner !== armed.runner)) process.exit(0); // turn ended, or a NEWER runner owns the stamp now
  if (!runnerAlive()) process.exit(0);                       // our runner is gone — never speak for it
  const now = probe();
  // 300ms slack on mtimes absorbs filesystem timestamp granularity (well under any real
  // activity gap — claude appends continuously); stderr keeps its old 200B slack.
  if (now.err > base.err + 200 || now.tr > base.tr + 300 || now.wk > base.wk + 300) {
    base = now; continue;                                    // producing work: alive, re-arm
  }
  const mins = Math.round((Date.now() - (s.startedAt || Date.now())) / 60000);
  const orch = `${hostId()}:${project}`;
  const text = `⏱ ${session} turn STALLED — running ${mins}m with no activity (turn ${s.turn}; last seen: ${describeLast(base)}). Not killed; check its pane, or \`trantor swap\`.`;
  // Direct = wake. The foreman first; if this seat IS the foreman's own runner, say it to all.
  const to = orch === session ? "all" : orch;
  try { await signedPost(`${hub}/send`, { from: session, to, text, project }, { session }); } catch {}
  process.exit(0);                                            // one report per turn, by construction
}

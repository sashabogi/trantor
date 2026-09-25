// #7749: a seat's LIVE turn state, one JSON file per seat — turnstate-<agent>-<project>.json in
// the bus dir. The runner writes it at every phase transition and its watchdog refreshes the
// liveness timestamps mid-turn, so `trantor seat-why`, the hub presence row and the app's
// sidebar read a fact instead of inferring one from ledger rows that only exist after a turn
// ends. Shape: { turn, phase: idle|working|cut|stalled|parked, since, card, lastBytesAt,
// lastTranscriptAt } — `since` is the phase's start (ms epoch), the rest is evidence.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const busDir = () => process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus");
export const turnStatePath = (agent, project, dir = busDir()) => join(dir, `turnstate-${agent}-${project}.json`);

export function readTurnStateFile(path) {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return j && typeof j === "object" ? j : null;
  } catch { return null; }
}
export function readTurnState(agent, project, dir = busDir()) {
  return readTurnStateFile(turnStatePath(agent, project, dir));
}

// tmp + rename: a reader mid-write sees the last whole file, never a torn one.
export function writeTurnStateFile(path, state) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, path);
    return true;
  } catch { return false; }
}

// Merge onto the last write: the runner's transition sets phase/since, everything else rides along.
export function writeTurnState(agent, project, patch, dir = busDir()) {
  const path = turnStatePath(agent, project, dir);
  return writeTurnStateFile(path, { ...(readTurnStateFile(path) || {}), ...patch });
}

// The watchdog's mid-turn refresh. It NEVER writes phase: transitions belong to the runner, and
// a poll landing after the turn ended must not resurrect "working" over the runner's idle —
// the turn-number + phase guard is what keeps a slow poll from lying.
export function refreshTurnLiveness(path, { turn, bytesAt = 0, transcriptAt = 0 }) {
  const cur = readTurnStateFile(path);
  if (!cur || cur.turn !== turn || cur.phase !== "working") return false;
  const patch = {};
  if (bytesAt) patch.lastBytesAt = bytesAt;
  if (transcriptAt) patch.lastTranscriptAt = transcriptAt;
  return Object.keys(patch).length ? writeTurnStateFile(path, { ...cur, ...patch }) : false;
}

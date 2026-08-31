#!/usr/bin/env node
// Turn watchdog (#5684). runTurn is spawnSync — the runner cannot watch its own turn — so this
// DETACHED helper does: armed at turn start, disarmed by turn end (the stamp file vanishes or
// its turn number moves on). A turn that runs past the window with NO output growth earns ONE
// direct stall report to the foreman (episode, never a timer storm), and the turn is never
// killed — reporting is the whole job. The operator's 2026-08-31 complaint is the incident:
// seats sat visibly dead in their panes while every signal channel stayed quiet.
//
//   node bin/turn-watchdog.mjs <stampFile> <errFile> <windowMs> <session> <project> <hubUrl>
import { readFileSync, existsSync, statSync } from "node:fs";
import { hostId } from "../lib/project.mjs";
import { signedPost } from "../hooks/lib/api.mjs";

const [stampFile, errFile, windowMsRaw, session, project, hub] = process.argv.slice(2);
const windowMs = Number(windowMsRaw) || 15 * 60 * 1000;   // no floor: drills pass tiny windows, and one report per turn caps the damage anyway
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readStamp = () => { try { return JSON.parse(readFileSync(stampFile, "utf8")); } catch { return null; } };
const errSize = () => { try { return statSync(errFile).size; } catch { return 0; } };

const armed = readStamp();
if (!armed) process.exit(0);
let baseline = errSize();

for (;;) {
  await sleep(windowMs);
  const s = readStamp();
  if (!s || s.turn !== armed.turn) process.exit(0);          // turn ended — nothing to say
  const size = errSize();
  if (size > baseline + 200) { baseline = size; continue; }  // producing output: working, re-arm
  const mins = Math.round((Date.now() - (s.startedAt || Date.now())) / 60000);
  const orch = `${hostId()}:${project}`;
  const text = `⏱ ${session} turn STALLED — running ${mins}m with no output (turn ${s.turn}). Not killed; check its pane, or \`trantor swap\`.`;
  // Direct = wake. The foreman first; if this seat IS the foreman's own runner, say it to all.
  const to = orch === session ? "all" : orch;
  try { await signedPost(`${hub}/send`, { from: session, to, text, project }, { session }); } catch {}
  process.exit(0);                                            // one report per turn, by construction
}

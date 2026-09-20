#!/usr/bin/env node
// Save a model-authored handoff (piped on stdin) for this project; the next session auto-loads it.
// With --baton: ALSO open a fresh self-announcing session and close THIS window once it takes over
// (the one-command manual baton behind /trantor:handoff). Without it: just write the file (legacy).
import { readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeHandoff, spawnBaton, resolveHandoffSurface } from "../hooks/lib/handoff.mjs";
import { handoffDir } from "../lib/project.mjs";

const baton = process.argv.includes("--baton");
// --latest: pass the baton on a handoff ALREADY on disk — composing it again cost 2m28s of
// regenerated prose on a live scribe session (drill: test/handoff/test-baton-latest.mjs).
const latest = process.argv.includes("--latest");
// #6074: ONE resolver for which project this is and where the session lives — shared with
// bin/baton.mjs so the two cannot diverge. The name comes from the registration
// (TRANTOR_ORCH / RELAY_PROJECT / orch-sessions.txt) before the cwd; a subfolder cwd never renames the project.
const resolved = resolveHandoffSurface({ sessionId: process.env.CLAUDE_SESSION_ID || "" });
const project = resolved.projectDir;
const name = resolved.project;
let summary = "";
if (!latest) {
  process.stdin.setEncoding("utf8");
  for await (const c of process.stdin) summary += c;
  // An empty handoff spawns a successor with nothing to take over. Refuse rather than hand over a
  // blank page.
  if (!summary.trim()) {
    console.error("nothing on stdin — pipe the handoff markdown in, or use --latest to pass the baton on one already written");
    process.exit(1);
  }
}
// One resolver, shared with the reader (lib/project.mjs). This file used to join homedir()
// directly, so an AGENT_BUS_DIR install wrote where nothing would look.
const dir = handoffDir();
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
// --latest short-circuits everything below: find this project's newest UNCONSUMED handoff and hand
// that over, untouched.
if (latest) {
  if (!existsSync(dir)) { console.error(`no handoffs directory at ${dir}`); process.exit(1); }
  const re = new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-(\\d+)\\.json$");
  const found = readdirSync(dir)
    .map(f => { const m = re.exec(f); return m ? { f, stamp: Number(m[1]) } : null; })
    .filter(Boolean)
    .sort((a, b) => b.stamp - a.stamp)
    .map(x => join(dir, x.f))
    .find(p => { try { return JSON.parse(readFileSync(p, "utf8")).consumed === false; } catch { return false; } });
  if (!found) { console.error(`no unconsumed handoff for "${name}" in ${dir} — write one first (pipe it in), then baton it`); process.exit(1); }
  console.log(`baton on the existing handoff: ${found}`);
  const r = spawnBaton({ projectDir: project, handoffFile: found });
  if (r.pane && r.spawned) console.log("baton: pane replacement armed (#5643) — this session ends at the turn boundary and the pane reopens fresh, self-recapping");
  else if (r.spawned) console.log(`baton: fresh session opening (self-recapping)${r.armed ? ` — this window (${r.windowId}) closes once it takes over` : ""}`);
  else console.log("baton: could not spawn a fresh session (non-macOS or spawn disabled) — handoff is saved, open a new session manually");
  process.exit(0);
}

// ONE WRITER (#8263): every guarantee CONTRACT-hooks states for "a handoff record" — the read-first
// floor, verifyGates, the sub-agent manifest, supersedeOlderHandoffs, uncapped persistence — lives
// in writeHandoff; the literal record assembled here reached none of them. Only trigger,
// transcript_path "" and force (the command IS the intent) differ.
const { file } = writeHandoff({
  projectDir: project,
  projectName: name,
  sessionId: "",
  transcript: "",
  trigger: baton ? "manual-baton" : "manual-skill",
  summary: summary.trim(),
  force: true,
});
console.log(`handoff saved: ${file}`);

if (baton) {
  const r = spawnBaton({ projectDir: project, handoffFile: file });
  if (r.pane && r.spawned) console.log("baton: pane replacement armed (#5643) — this session ends at the turn boundary and the pane reopens fresh, self-recapping");
  else if (r.spawned) console.log(`baton: fresh session opening (self-recapping)${r.armed ? ` — this window (${r.windowId}) closes once it takes over` : " — original window left open (couldn't detect it)"}`);
  else console.log(`baton: could not spawn a fresh session (non-macOS or spawn disabled) — handoff saved, open a new session manually`);
}

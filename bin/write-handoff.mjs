#!/usr/bin/env node
// Save a model-authored handoff (piped on stdin) for this project; the next session auto-loads it.
// With --baton: ALSO open a fresh self-announcing session and close THIS window once it takes over
// (the one-command manual baton behind /trantor:handoff). Without it: just write the file (legacy).
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir, hostname } from "node:os";
import { execSync } from "node:child_process";
import { spawnBaton, handoffMode } from "../hooks/lib/handoff.mjs";
import { handoffDir } from "../lib/project.mjs";

const baton = process.argv.includes("--baton");
// --latest: pass the baton on a handoff ALREADY on disk. Without it the only route was "compose a
// fresh one on stdin", so a session that had just written a 5KB handoff had to write it again to
// hand it over — 2m28s of regenerated prose on a live scribe session, 2026-08-24.
const latest = process.argv.includes("--latest");
const project = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const name = basename(project);
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
const stamp = (() => { try { return execSync("date +%s", { encoding: "utf8" }).trim(); } catch { return String(process.pid); } })();
let git = ""; try { git = execSync("git -C " + JSON.stringify(project) + " status --short 2>/dev/null | head -30", { encoding: "utf8" }).trim(); } catch {}
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
  const { spawned, armed, windowId } = spawnBaton({ projectDir: project, handoffFile: found });
  if (spawned) console.log(`baton: fresh session opening (self-recapping)${armed ? ` — this window (${windowId}) closes once it takes over` : ""}`);
  else console.log("baton: could not spawn a fresh session (non-macOS or spawn disabled) — handoff is saved, open a new session manually");
  process.exit(0);
}

// The manual skill path opens the §5 ledger with WRITTEN like every other writer (#5642), and
// carries the same interface the hooks-side records have: transcript_path ("" — the summary IS
// the model's own words), mode (attended|unattended, #5648).
const rec = { id: `${name}-${stamp}`, project, projectName: name, machine: hostname(), trigger: baton ? "manual-baton" : "manual-skill", stamp: Number(stamp) || 0, summary: summary.trim() || "(empty)", transcript_path: "", mode: handoffMode(name), gitStatus: git, consumed: false, states: [{ state: "written", ts: Number(stamp) || 0, by: baton ? "manual-baton" : "manual-skill" }] };
const file = join(dir, `${rec.id}.json`);
writeFileSync(file, JSON.stringify(rec, null, 2));
console.log(`handoff saved: ${file}`);

if (baton) {
  const { spawned, armed, windowId } = spawnBaton({ projectDir: project, handoffFile: file });
  if (spawned) console.log(`baton: fresh session opening (self-recapping)${armed ? ` — this window (${windowId}) closes once it takes over` : " — original window left open (couldn't detect it)"}`);
  else console.log(`baton: could not spawn a fresh session (non-macOS or spawn disabled) — handoff saved, open a new session manually`);
}

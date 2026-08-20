#!/usr/bin/env node
// trantor/kimi — save a model-authored handoff (piped on stdin) for this project; the next Kimi
// session auto-loads it on SessionStart. With --baton: ALSO open a fresh `kimi` session and close
// THIS window once it takes over (the one-command manual baton behind the handoff skill).
// Without it: just write the file. Kimi port of bin/write-handoff.mjs.
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir, hostname } from "node:os";
import { execSync } from "node:child_process";
import { spawnBaton } from "./lib/handoff.mjs";

const baton = process.argv.includes("--baton");
// This runs through the agent's Bash tool, whose cwd IS the session's project directory.
const project = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const name = basename(project);
let summary = ""; process.stdin.setEncoding("utf8");
for await (const c of process.stdin) summary += c;
const dir = join(homedir(), ".agent-bus", "handoffs");
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const stamp = (() => { try { return execSync("date +%s", { encoding: "utf8" }).trim(); } catch { return String(process.pid); } })();
let git = ""; try { git = execSync("git -C " + JSON.stringify(project) + " status --short 2>/dev/null | head -30", { encoding: "utf8" }).trim(); } catch {}
const rec = { id: `${name}-${stamp}`, project, projectName: name, machine: hostname(), agent: "kimi", trigger: baton ? "manual-baton" : "manual-skill", stamp: Number(stamp) || 0, summary: summary.trim() || "(empty)", gitStatus: git, consumed: false };
const file = join(dir, `${rec.id}.json`);
writeFileSync(file, JSON.stringify(rec, null, 2));
console.log(`handoff saved: ${file}`);

if (baton) {
  const { spawned, armed, windowId } = spawnBaton({ projectDir: project, handoffFile: file });
  if (spawned) console.log(`baton: fresh kimi session opening (the handoff loads on its SessionStart)${armed ? ` — this window (${windowId}) closes once it takes over` : " — original window left open (couldn't detect it)"}`);
  else console.log(`baton: could not spawn a fresh session (non-macOS or spawn disabled) — handoff saved, open a new session manually`);
}

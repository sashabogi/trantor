#!/usr/bin/env node
// `trantor handoff` — one-command manual baton (auto-summary variant). Discovers the current session's
// transcript, writes a whole-session handoff (auto-summary + verbatim in-flight tail), opens a fresh
// self-announcing session, and closes THIS window once it takes over. Run from inside the session you
// want to hand off. (The richer MODEL-authored handoff is the /trantor:handoff skill.)
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveProject } from "../lib/project.mjs";
import { writeHandoff, spawnBaton } from "../hooks/lib/handoff.mjs";

const cwd = process.cwd();
const project = resolveProject(cwd);

// The active session's transcript = newest *.jsonl directly in this project's Claude dir
// (~/.claude/projects/<cwd-with-slashes-as-dashes>/), excluding the subagents/ subtree.
function findTranscript() {
  const dashed = cwd.replace(/\//g, "-");
  const base = join(homedir(), ".claude", "projects");
  let best = "", bestM = 0;
  let dirs = []; try { dirs = readdirSync(base).filter(d => d === dashed || d.endsWith(dashed)); } catch {}
  for (const d of dirs) {
    let ents = []; try { ents = readdirSync(join(base, d)); } catch {}
    for (const f of ents) {
      if (!f.endsWith(".jsonl")) continue;
      try { const m = statSync(join(base, d, f)).mtimeMs; if (m > bestM) { best = join(base, d, f); bestM = m; } } catch {}
    }
  }
  return best;
}

const transcript = findTranscript();
const { file } = writeHandoff({ projectDir: cwd, sessionId: "", transcript, trigger: "manual-cli", force: true });   // manual = intentional, bypass the storm guard
console.log(`📋 handoff saved for ${project}: ${file}`);
const { spawned, armed, windowId } = spawnBaton({ projectDir: cwd, handoffFile: file });
console.log(spawned
  ? `🔄 baton: a fresh session is opening (it'll recap the handoff)${armed ? ` — this window (${windowId}) closes once it takes over` : " — couldn't detect this window; close it yourself once the new one is up"}`
  : `handoff saved, but couldn't spawn a fresh session (non-macOS or spawn disabled) — open a new session here to take over`);

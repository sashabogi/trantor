#!/usr/bin/env node
// `trantor handoff` — one-command manual baton. Discovers the current session's transcript, writes
// a whole-session handoff (auto-summary + verbatim in-flight tail), opens a fresh self-announcing
// session, and closes THIS window once it takes over. Run from inside the session you want to hand
// off. (The richer MODEL-authored handoff is the /trantor:handoff skill.)
import { readdirSync, statSync, fstatSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeHandoff, spawnBaton, resolveHandoffSurface } from "../hooks/lib/handoff.mjs";

// #6074: the skill path (write-handoff.mjs) and this CLI path must share ONE resolution of which
// project this is and where the session lives. Both call resolveHandoffSurface; the name comes
// from the session's registration (TRANTOR_ORCH / RELAY_PROJECT / orch-sessions.txt) before the
// cwd — a subfolder cwd never renames the project.
const cwd = process.cwd();
const resolved = resolveHandoffSurface({ projectDir: process.env.CLAUDE_PROJECT_DIR || cwd, sessionId: process.env.CLAUDE_SESSION_ID || "" });
const project = resolved.project;
// #6218 — the transcript is found under the RESOLVED session directory (CLAUDE_PROJECT_DIR, the
// dir the session was launched in — how Claude itself names ~/.claude/projects), never a shell
// cwd that cd'd somewhere else: a handoff record must carry the transcript it was written from.
const sessionDir = resolved.projectDir;

// Model-authored handoffs ride THIS binary too (`trantor handoff` — always the global install's
// CURRENT code, never the plugin-cache copy a session booted with, the stale-0.18.20 bug). A piped
// stdin (a heredoc, a cat, `<<HANDOFF`) means "here is the handoff markdown" — exactly the skill's
// contract — so forward to write-handoff.mjs in the SAME package (same version, same resolution)
// and exit with its status. --latest forwards too. A true pipe is a FIFO; a TTY and /dev/null are
// character devices, so a plain `trantor handoff` typed at a prompt (or run by a hook with stdin
// at /dev/null) keeps the auto-summary behavior. Detection must NOT be `!process.stdin.isTTY` —
// that misreads /dev/null as a handoff and errors where auto-summary used to work.
function stdinIsPipe() {
  try { return fstatSync(0).isFIFO(); } catch { return false; }
}
if (stdinIsPipe() || process.argv.includes("--latest")) {
  const helper = join(dirname(fileURLToPath(import.meta.url)), "write-handoff.mjs");
  const child = spawn(process.execPath, [helper, ...process.argv.slice(2)], { stdio: ["inherit", "inherit", "inherit"] });
  child.on("exit", (c) => process.exit(c ?? 1));
  child.on("error", () => process.exit(1));
} else {
  autoBaton();
}

// The active session's transcript = newest *.jsonl directly in the session dir's Claude dir
// (~/.claude/projects/<sessionDir-with-slashes-as-dashes>/), excluding the subagents/ subtree.
function findTranscript() {
  const dashed = sessionDir.replace(/\//g, "-");
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

function autoBaton() {
  const transcript = findTranscript();
  // The transcript's filename IS the writing session's id — record it, or an orchestrator-thread
  // handoff carries no writer and the baton-hold + map-follow logic in sessionstart.mjs can't fire.
  const sessionId = transcript ? basename(transcript, ".jsonl") : "";
  const { file } = writeHandoff({ projectDir: cwd, sessionId, transcript, trigger: "manual-cli", force: true, projectName: project });   // manual = intentional, bypass the storm guard
  console.log(`📋 handoff saved for ${project}: ${file}`);
  // --write-only: the in-app flow (#5509). The app ends the pane's session itself and reopens it
  // through `trantor open`, which claims this handoff — a Terminal window here would be exactly the
  // wrong surface, so the flag writes, announces, and stops.
  if (process.argv.includes("--write-only")) {
    console.log(`🔄 write-only: no window spawned — the pane takeover (trantor open) claims it next.`);
    process.exit(0);
  }
  const { spawned, armed, windowId } = spawnBaton({ projectDir: cwd, handoffFile: file });
  console.log(spawned
    ? `🔄 baton: a fresh session is opening (it'll recap the handoff)${armed ? ` — this window (${windowId}) closes once it takes over` : " — couldn't detect this window; close it yourself once the new one is up"}`
    : `handoff saved, but couldn't spawn a fresh session (non-macOS or spawn disabled) — open a new session here to take over`);
}

#!/usr/bin/env node
// trantor agents [sessionId] [--json] — the LIVE sub-agent manifest for a session.
//
// What were this session's sub-agents (Agent/Task tool, Workflow swarms, agent-teams) doing —
// what was each tasked with, did it return, what did it write, and do those files still survive
// on disk? Derived fresh from the on-disk transcripts every run (so it reflects CURRENT disk,
// catching files an agent finished that were later clobbered — the 2026-06-21 kill corrupted a
// completed 30KB lib down to a 17-byte stub).
//
//   trantor agents                 → the session of the newest handoff for THIS project (the
//                                     predecessor a fresh session is taking over from)
//   trantor agents <sessionId>     → that specific session
//   trantor agents --json          → structured manifest (for tools)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { deriveSubagentManifest, formatSubagentManifest, resolveTranscriptForSid } from "../lib/subagent-manifest.mjs";

const args = process.argv.slice(2);
const json = args.includes("--json");
const sid = args.find((a) => !a.startsWith("--"));

const HANDOFF_DIR = join(process.env.RELAY_DATA_DIR || join(homedir(), ".agent-bus"), "handoffs");

// Newest handoff record whose project matches the cwd — gives us the predecessor's transcript
// path + project root directly (no glob needed), so `trantor agents` with no arg "just works"
// for a fresh session taking over.
function newestHandoffForCwd() {
  try {
    if (!existsSync(HANDOFF_DIR)) return null;
    const cwd = process.cwd(), name = basename(cwd);
    const recs = readdirSync(HANDOFF_DIR)
      .filter((f) => /-\d+\.json$/.test(f))
      .map((f) => { try { return JSON.parse(readFileSync(join(HANDOFF_DIR, f), "utf8")); } catch { return null; } })
      .filter((r) => r && (r.project === cwd || r.projectName === name))
      .sort((a, b) => (Number(b.stamp) || 0) - (Number(a.stamp) || 0));
    return recs[0] || null;
  } catch { return null; }
}

let transcript = "", projectRoot = process.cwd();
if (sid) {
  transcript = resolveTranscriptForSid(sid);
  if (!transcript) {
    console.error(`No transcript found for session ${sid} under ~/.claude/projects/*/.`);
    process.exit(1);
  }
} else {
  const h = newestHandoffForCwd();
  if (!h) {
    console.error(`No handoff found for this project. Pass a session id explicitly: trantor agents <sessionId>`);
    process.exit(1);
  }
  transcript = h.transcript_path || resolveTranscriptForSid(h.session_id);
  projectRoot = h.project || projectRoot;
}

const manifest = deriveSubagentManifest(transcript, { projectRoot });
if (json) {
  process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
} else {
  process.stdout.write(formatSubagentManifest(manifest) + "\n");
}

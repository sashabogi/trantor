#!/usr/bin/env node
// trantor agents [sessionId] [--json] [--since <epochMs>] — the LIVE sub-agent manifest for a
// session: what was each sub-agent tasked with, did it return, what did it write, did it survive
// on disk — re-derived fresh from the transcripts every run. `--since <epochMs>` (#10007) reads
// agents launched before that instant "stale", never "in-flight"; the app polls this for liveness.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { deriveSubagentManifest, formatSubagentManifest, resolveTranscriptForSid } from "../lib/subagent-manifest.mjs";

const args = process.argv.slice(2);
const json = args.includes("--json");
const sinceIdx = args.indexOf("--since");
const sinceVal = sinceIdx !== -1 ? args[sinceIdx + 1] : undefined;
const sinceMs = sinceVal != null ? Number(sinceVal) : undefined;
const sid = args.find((a) => !a.startsWith("--") && a !== sinceVal);

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

const manifest = deriveSubagentManifest(transcript, { projectRoot, sinceMs: Number.isFinite(sinceMs) ? sinceMs : undefined });
if (json) {
  process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
} else {
  process.stdout.write(formatSubagentManifest(manifest) + "\n");
}

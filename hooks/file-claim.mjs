#!/usr/bin/env node
// trantor PreToolUse file-claim — before every file edit the session posts a claim and the hub answers
// with any LIVE claim on the same file by another session, handed to the model as context.
// Informational, never blocking: a lock server that fails open is worse than no lock. Fail-open and
// cheap: tight timeout, per-(session,file) stamp throttles re-claims; the FIRST touch always goes out.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { relayUrl, sessionContext, signedPost } from "./lib/api.mjs";

const FETCH_TIMEOUT_MS = Number(process.env.RELAY_CLAIM_TIMEOUT_MS || 900);
const RECLAIM_MS = Number(process.env.RELAY_RECLAIM_MS || 60 * 1000);

const allow = () => { process.stdout.write("{}"); process.exit(0); };

function readStdin() {
  return new Promise(res => {
    let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => { d += c; });
    process.stdin.on("end", () => res(d));
    setTimeout(() => res(d), 400);
  });
}

function fileOf(toolName, input) {
  // Only the tool input's own path fields are read; a truthy non-object input has neither, and
  // String(undefined || "") is "" exactly like the old object guard returned.
  if (!input) return "";
  if (toolName === "NotebookEdit") return String(input.notebook_path || "");
  return String(input.file_path || "");
}

const ago = s => (s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`);

try {
  const raw = await readStdin();
  const input = JSON.parse(raw || "{}");
  const abs = fileOf(String(input.tool_name || ""), input.tool_input);
  if (!abs) allow();

  const ctx = sessionContext(input.cwd);
  if (!ctx.project) allow();
  // claims compare by path, and absolute paths differ per machine — store repo-relative
  const file = isAbsolute(abs) && !relative(ctx.projectDir, abs).startsWith("..")
    ? relative(ctx.projectDir, abs)
    : abs;

  // throttle re-claims of the same file; never throttle its first touch
  const stampDir = join(process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus"), "claims");
  const stamp = join(stampDir, `${ctx.session} ${file}`.replace(/[^A-Za-z0-9_.-]/g, "_"));
  try {
    const last = Number(readFileSync(stamp, "utf8"));
    if (Date.now() - last < RECLAIM_MS) allow();
  } catch {}

  const r = await signedPost(`${relayUrl(ctx.project)}/claim`,
    { project: ctx.project, file, session: ctx.session },
    { timeoutMs: FETCH_TIMEOUT_MS, session: ctx.session });

  try { mkdirSync(stampDir, { recursive: true }); writeFileSync(stamp, String(Date.now())); } catch {}

  const conflicts = r.ok ? r.json?.conflicts ?? [] : [];
  if (!conflicts.length) allow();

  const who = conflicts.map(c => `${c.session} (${ago(c.agoSec)} ago)`).join(", ");
  // NO permissionDecision on purpose: additionalContext reaches the model on its own, and an "allow"
  // here would bypass the operator's own Edit/Write permission rules for exactly these files.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        `⚠️ trantor: ${who} also edited ${file} in project "${ctx.project}" within the last few minutes — ` +
        `you are both touching the same file RIGHT NOW. Before making conflicting changes, coordinate over ` +
        `the bus: relay_send to ${conflicts[0].session} saying what you're changing, or split the work. ` +
        `Proceed only if your edits cannot collide.`,
    },
  }));
  process.exit(0);
} catch {
  allow();
}

#!/usr/bin/env node
// trantor PreToolUse file-claim — shared-resource awareness across sessions.
//
// THE problem this solves: two orchestrators (or an orchestrator and a crew seat) touching the
// same project learn about each other's edits at git time — merge conflicts, clobbered work,
// "Edit succeeded but didn't persist". The bus already carries messages; this makes it carry
// INTENT: before every file edit, the session posts a claim, and the hub answers with any LIVE
// claim on the same file by a DIFFERENT session. That answer is handed to the acting session's
// own model as context — through its own harness, the only safe channel (see stop-inbox.mjs for
// why reaching across process boundaries is forbidden).
//
// Deliberately INFORMATIONAL, never blocking: a warning in context lets the model decide to
// coordinate (relay_send) or proceed; a denied edit would make the hook a lock server, and a
// lock server that fails open (as hooks must) is worse than no lock at all.
//
// Fail-open + cheap by contract: tight timeout, per-(session,file) stamp throttles re-claims of
// the same file to once per window — but the FIRST touch of each file always goes out, and that
// is exactly the moment a collision warning matters.
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
  // NO permissionDecision on purpose. This hook exists to WARN, and `additionalContext` reaches the
  // model on its own — a decision is not required to deliver it. Setting "allow" here (as this did
  // until 2026-08-12) approves the tool call and bypasses the operator's own permission rules, so a
  // deny or an approval prompt on Edit/Write was silently overridden for exactly the files two
  // sessions were fighting over. Omitting it leaves the normal permission flow untouched.
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

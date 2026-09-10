#!/usr/bin/env node
// trantor Notification hook — cards CC's own background/child agents (which never pass through the
// SubagentStart/Stop path) as source:"cc-bg-agent": agent_needs_input → blocked, agent_completed → done.
// The payload's agent-id field is undocumented, so several candidates are read; TRANTOR_DEBUG_NOTIFY=1
// dumps the raw payload. Fail-silent: a notification must never block the session.
import { resolveProject, hostId } from "../lib/project.mjs";
import { signedPost } from "./lib/api.mjs";

function readStdin() {
  return new Promise(res => { let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => (d += c)); process.stdin.on("end", () => res(d));
    setTimeout(() => res(d), 100); });
}

try {
  const input = JSON.parse((await readStdin()) || "{}");
  if (process.env.TRANTOR_DEBUG_NOTIFY === "1") process.stderr.write(`[trantor] notify payload: ${JSON.stringify(input)}\n`);
  const ntype = String(input.notification_type || input.notificationType || input.type || "");
  // only the two agent-lifecycle notification types are board-relevant; ignore permission/idle/auth/elicitation
  if (ntype !== "agent_needs_input" && ntype !== "agent_completed") { process.stdout.write("{}"); process.exit(0); }

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const project = resolveProject(cwd);
  // candidate id for pairing needs_input→completed and for guarding vs an already-carded cc-subagent. The
  // agent's OWN session id is the most likely stable key for a background/child agent across both events.
  const agentId = String(input.agent_id || input.agentId || input.session_id || input.sessionId || "").slice(0, 120);
  const agentType = String(input.agent_type || input.agentType || "agent").slice(0, 40);
  // parent = the session that spawned it → nest under that session's focus card (same rule as cc-subagent)
  const parent = String(input.parent_session_id || input.parentSessionId || "").slice(0, 120);
  // a lightly-cleaned human label; Notification carries a `message`. NOTE: Teams privacy gate applies before
  // this reaches a shared board (it can carry prompt text) — same rule as focus-card titles.
  const msg = String(input.message || "").replace(/\s+/g, " ").trim().slice(0, 90);
  const title = `${agentType}${msg ? `: ${msg}` : ""}`.slice(0, 180);

  await signedPost("/task", {
      project, source: "cc-bg-agent", notificationType: ntype,
      title, agentId, agentType, parent,
      assignee: `${agentType}:${project}`, by: `${hostId()}:${project}`, phase: "sub-agents",
    });
} catch (e) {
  process.stderr.write(`[trantor] agent-notify error: ${e?.message || e}\n`);
}
process.stdout.write("{}");
process.exit(0);

#!/usr/bin/env node
// trantor Notification hook — surface CC's OWN background/child agents (the `claude agents` / fork / subtask
// sessions that DON'T go through the Task-tool sub-agent path, so SubagentStart/Stop never see them) on the
// board. CC fires a Notification with notification_type "agent_needs_input" (the agent paused, waiting on the
// user) or "agent_completed" (it finished). We card these as source:"cc-bg-agent" — a DISTINCT population
// from cc-subagent, so they never double-count against sub-agent notional cost.
//
//   • agent_needs_input → post/flip a card to "blocked" (needs input) so the board shows it's waiting.
//   • agent_completed   → flip/close the card to "done".
//
// UNVERIFIED-LIVE: the Notification stdin payload's exact field names for the agent id are not documented
// (session_id + notification_type + message are the confirmed fields). We read several candidates and let the
// hub key/guard on whatever we send; TRANTOR_DEBUG_NOTIFY=1 dumps the raw payload to stderr so the first real
// firing reveals the true shape. Fail-silent: a notification must never block the session.
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

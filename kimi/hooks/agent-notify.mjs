#!/usr/bin/env node
// trantor Notification hook — Kimi Code port. Kimi's Notification event fires on background-task
// status changes (matcher examples: "task.completed") — the closest analogue to Claude's
// background/child-agent notifications. We card background-task completions/failures on the board
// as source:"kimi-bg-task" — a DISTINCT population from cc-subagent cards, so they never
// double-count against sub-agent notional cost. Field names are undocumented → defensive reads;
// TRANTOR_DEBUG_HOOKS=1 dumps the raw payload so the first real firing reveals the true shape.
// Fail-silent: a notification must never block the session.
import { readPayload, payloadCwd, isHomeSession, identity, relayUrl, debugHook, hostId } from "./lib/common.mjs";

const pick = (obj, keys) => { for (const k of keys) { if (obj && obj[k] != null && obj[k] !== "") return obj[k]; } return ""; };

try {
  const payload = await readPayload();
  debugHook("Notification", payload);
  const ntype = String(pick(payload, ["notification_type", "notificationType", "type", "kind"])).toLowerCase();
  if (!ntype) { process.exit(0); }

  const cwd = payloadCwd(payload);
  if (isHomeSession(cwd)) process.exit(0);
  const { project } = identity(cwd);

  // Map the notification to a board status: completions close "done", failures/needs-input go
  // "blocked" (visible, waiting), anything else just shows as activity ("doing" is wrong → skip).
  let status = "";
  if (/complet|finish|done|success/.test(ntype)) status = "done";
  else if (/fail|error|needs_input|needs-input|blocked/.test(ntype)) status = "blocked";
  if (!status) { process.exit(0); }

  const taskId = String(pick(payload, ["task_id", "taskId", "id"])).slice(0, 120);
  const title = String(pick(payload, ["title", "message", "description", "text"]) || "background task")
    .replace(/\s+/g, " ").trim().slice(0, 90);

  await fetch(`${relayUrl()}/task`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project, source: "kimi-bg-task", notificationType: ntype,
      title: `bg ${title}`.slice(0, 180), status, agentId: taskId, agentType: "bg-task",
      assignee: `bg-task:${project}`, by: `${hostId()}:${project}`, phase: "sub-agents",
    }),
    signal: AbortSignal.timeout(1500),
  }).catch(() => {});
} catch (e) {
  process.stderr.write(`[trantor] kimi agent-notify error: ${e?.message || e}\n`);
}
process.exit(0);

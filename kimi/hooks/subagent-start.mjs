#!/usr/bin/env node
// trantor sub-agent in-flight hook — Kimi Code port. Posts/enriches a "doing" card so the board
// shows sub-agent work IN PROGRESS while it runs; the SubagentStop hook flips it to "done".
// ONE script serves TWO hook events (dispatch on hook_event_name), like the Claude version:
//
//   • PreToolUse (matcher Agent|AgentSwarm) — fires at DISPATCH TIME and carries tool_input with
//     Kimi's Agent-tool args ({prompt, description, subagent_type, …}) → CREATE the in-flight card.
//
//   • SubagentStart — fires when the sub-agent actually SPAWNS; Kimi's payload field names are
//     undocumented, so ids/types are read defensively (agent_id|id|subagent_id,
//     agent_type|subagent_type|name, parent_session_id|session_id) → ENRICH the card (or CREATE
//     keyed by agent id when no PreToolUse card exists, so nothing orphans).
//
// Fail-silent throughout — never block or delay a dispatch. TRANTOR_DEBUG_HOOKS=1 dumps payloads.
import { readPayload, payloadCwd, isHomeSession, identity, relayUrl, toolInput, debugHook, hostId } from "./lib/common.mjs";

const post = (url, body) => fetch(url, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify(body), signal: AbortSignal.timeout(1500),
}).catch(() => {});

const pick = (obj, keys) => { for (const k of keys) { if (obj && obj[k] != null && obj[k] !== "") return obj[k]; } return ""; };

try {
  const payload = await readPayload();
  debugHook(payload.hook_event_name === "SubagentStart" ? "SubagentStart" : "PreToolUse:subagent", payload);
  const cwd = payloadCwd(payload);
  if (isHomeSession(cwd)) { process.exit(0); }
  const { project } = identity(cwd);
  const url = `${relayUrl()}/task`;

  if (payload.hook_event_name === "SubagentStart") {
    // ENRICH path — the sub-agent has spawned; attach its real id + parent to the in-flight card.
    const agentType = String(pick(payload, ["agent_type", "subagent_type", "name", "agentType"]) || "subagent").slice(0, 40);
    const agentId = String(pick(payload, ["agent_id", "agentId", "subagent_id", "id"])).slice(0, 80);
    const parent = String(pick(payload, ["parent_session_id", "parentSessionId", "session_id"])).slice(0, 120);
    if (agentId) {
      await post(url, {
        project, enrich: true, agentType, agentId, parent,
        by: `${hostId()}:${project}`,
        source: "cc-subagent", costKind: "subagent-notional", phase: "sub-agents",
      });
    }
  } else {
    // CREATE path (PreToolUse Agent|AgentSwarm) — dispatch time, has the prompt → good title.
    const ti = toolInput(payload);
    const agentType = String(ti.subagent_type || ti.agent_type || "subagent").slice(0, 40);
    // MUST mirror subagent-cost.mjs's title derivation so the hub's title fingerprint pairs the
    // start card with the stop card on the legacy (no-agent-id) path.
    const task = String(ti.prompt || ti.description || agentType).replace(/\s+/g, " ").trim().slice(0, 90);
    const title = `${agentType}: ${task}`.slice(0, 180);
    await post(url, {
      project, title, status: "doing", agentType,
      assignee: `${agentType}:${project}`, by: `${hostId()}:${project}`,
      source: "cc-subagent", costKind: "subagent-notional", phase: "sub-agents",
    });
  }
} catch (e) {
  process.stderr.write(`[trantor] kimi subagent-start error: ${e?.message || e}\n`);
}
process.exit(0);

#!/usr/bin/env node
// trantor sub-agent in-flight hook: posts/enriches a "doing" card while a sub-agent runs; subagent-cost
// flips it to done. ONE script, TWO events: PreToolUse (Task|Agent) has the prompt and CREATES the
// card (source "cc-subagent"); SubagentStart has agent_id + parent and ENRICHES that card, creating
// one keyed by agent_id only when none exists. Never double-posts; fail-silent, never delays a dispatch.
import { resolveProject, hostId } from "../lib/project.mjs";
import { signedPost } from "./lib/api.mjs";

function readStdin() {
  return new Promise(res => { let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => (d += c)); process.stdin.on("end", () => res(d));
    setTimeout(() => res(d), 100); });
}

try {
  const input = JSON.parse((await readStdin()) || "{}");
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const project = resolveProject(cwd);

  if (input.hook_event_name === "SubagentStart") {
    // ENRICH path — the sub-agent has spawned; attach its real id + parent to the in-flight card.
    // agent_type is the native SubagentStart field (PreToolUse used tool_input.subagent_type).
    const agentType = String(input.agent_type || input.subagent_type || "subagent").slice(0, 40);
    const agentId = String(input.agent_id || "").slice(0, 80);
    // parent = the session that spawned this sub-agent → nest it under that session's focus card.
    const parent = String(input.parent_session_id || input.session_id || "").slice(0, 120);
    if (agentId) {
      await signedPost("/task", {
        project, enrich: true, agentType, agentId, parent,
        by: `${hostId()}:${project}`,
        source: "cc-subagent", costKind: "subagent-notional", phase: "sub-agents",
      });
    }
  } else {
    // CREATE path (PreToolUse Task|Agent) — dispatch time, has the prompt → good title.
    const ti = input.tool_input || {};
    const agentType = String(ti.subagent_type || "subagent").slice(0, 40);
    // MUST mirror subagent-cost.mjs's title derivation so the hub's title fingerprint pairs this start card
    // with the SubagentStop "done" card on any client that predates agent_id pairing (legacy fallback).
    const task = String(ti.prompt || ti.description || agentType).replace(/\s+/g, " ").trim().slice(0, 90);
    const title = `${agentType}: ${task}`.slice(0, 180);
    // parent at CREATE time too, not only on the SubagentStart enrich — a card that spends its
    // whole doing-life unparented is un-nestable exactly while it is the interesting one.
    await signedPost("/task", {
      project, title, status: "doing", agentType,
      parent: String(input.session_id || "").slice(0, 120),
      assignee: `${agentType}:${project}`, by: `${hostId()}:${project}`,
      source: "cc-subagent", costKind: "subagent-notional", phase: "sub-agents",
    });
  }
} catch (e) {
  process.stderr.write(`[trantor] subagent-start error: ${e?.message || e}\n`);
}
process.stdout.write("{}");
process.exit(0);

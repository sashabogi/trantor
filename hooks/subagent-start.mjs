#!/usr/bin/env node
// trantor sub-agent in-flight hook — posts/enriches a "doing" card so the board shows sub-agent work IN
// PROGRESS while it runs. The SubagentStop hook (subagent-cost.mjs) flips it to "done" (with notional cost).
//
// This ONE script serves TWO hook events (dispatch on input.hook_event_name):
//
//   • PreToolUse (matcher Task|Agent) — fires at DISPATCH TIME and carries tool_input.prompt, so it has a
//     good human title. It CREATES the in-flight card (source:"cc-subagent", title-fingerprinted). Works on
//     every CC version → the universal in-flight source, no regression on older CC.
//
//   • SubagentStart (native, CC 2.1.x+) — fires when the sub-agent actually SPAWNS and carries the real
//     agent_id + agent_type (+ parent session), but NO prompt. It ENRICHES the card the PreToolUse create
//     already made: stamps agent_id (robust start↔stop pairing key, replacing the fragile title match) and
//     parent (for nesting sub-agents under the session focus card). If no create card exists (a spawn with
//     no matching PreToolUse — rare), it CREATES one keyed by agent_id so nothing orphans.
//
// Registering BOTH never double-posts: on modern CC the PreToolUse create runs first, then SubagentStart
// finds that card by (project, agentType) and enriches in place (creates nothing). Fail-silent throughout —
// never block or delay a dispatch.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveProject, hostId } from "../lib/project.mjs";

function readStdin() {
  return new Promise(res => { let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => (d += c)); process.stdin.on("end", () => res(d));
    setTimeout(() => res(d), 100); });
}
function relayUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL;
  try { const c = join(homedir(), ".agent-bus", "config.json"); if (existsSync(c)) { const u = JSON.parse(readFileSync(c, "utf8")).url; if (u) return u; } } catch {}
  return "http://127.0.0.1:4477";
}
const post = (url, body) => fetch(url, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify(body), signal: AbortSignal.timeout(1500),
}).catch(() => {});

try {
  const input = JSON.parse((await readStdin()) || "{}");
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const project = resolveProject(cwd);
  const url = `${relayUrl()}/task`;

  if (input.hook_event_name === "SubagentStart") {
    // ENRICH path — the sub-agent has spawned; attach its real id + parent to the in-flight card.
    // agent_type is the native SubagentStart field (PreToolUse used tool_input.subagent_type).
    const agentType = String(input.agent_type || input.subagent_type || "subagent").slice(0, 40);
    const agentId = String(input.agent_id || "").slice(0, 80);
    // parent = the session that spawned this sub-agent → nest it under that session's focus card.
    const parent = String(input.parent_session_id || input.session_id || "").slice(0, 120);
    if (agentId) {
      await post(url, {
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
    await post(url, {
      project, title, status: "doing", agentType,
      assignee: `${agentType}:${project}`, by: `${hostId()}:${project}`,
      source: "cc-subagent", costKind: "subagent-notional", phase: "sub-agents",
    });
  }
} catch (e) {
  process.stderr.write(`[trantor] subagent-start error: ${e?.message || e}\n`);
}
process.stdout.write("{}");
process.exit(0);

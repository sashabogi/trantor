#!/usr/bin/env node
// trantor PreToolUse hook (Task|Agent) — when a sub-agent is DISPATCHED, post an in-flight "doing" card so
// the board shows work IN PROGRESS while it runs. The existing SubagentStop hook (subagent-cost.mjs) flips
// the matching card to "done" via the hub's cc-subagent title-fingerprint dedup. Without this, every auto-
// card was born "done" (SubagentStop/git-backfill) so nothing ever showed as in progress. Fail-silent:
// never block or delay the dispatch.
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

try {
  const input = JSON.parse((await readStdin()) || "{}");
  const ti = input.tool_input || {};
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const project = resolveProject(cwd);
  const agentType = String(ti.subagent_type || "subagent").slice(0, 40);
  // MUST mirror subagent-cost.mjs's title derivation (lines 100-101) so the hub's title fingerprint pairs
  // this start card with the SubagentStop "done" card into ONE rolling cc-subagent card.
  const task = String(ti.prompt || ti.description || agentType).replace(/\s+/g, " ").trim().slice(0, 90);
  const title = `${agentType}: ${task}`.slice(0, 180);
  await fetch(`${relayUrl()}/task`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project, title, status: "doing",
      assignee: `${agentType}:${project}`, by: `${hostId()}:${project}`,
      source: "cc-subagent", costKind: "subagent-notional", phase: "sub-agents",
    }),
    signal: AbortSignal.timeout(1500),
  }).catch(() => {});
} catch (e) {
  process.stderr.write(`[trantor] subagent-start error: ${e?.message || e}\n`);
}
process.stdout.write("{}");
process.exit(0);

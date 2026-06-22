#!/usr/bin/env node
// trantor SubagentStop hook — when a Claude Code sub-agent (Agent/Task tool, Workflow swarm, ultracode,
// agent-team teammate) finishes, read ITS OWN transcript's token usage and post a board card tagged with
// the NOTIONAL API cost (what those tokens would cost at API rates — plan-covered, not billed, on a sub).
// No hook carries cost, so we parse the sub-agent transcript (confirmed to carry per-turn message.usage +
// message.model). This is the orchestrator's-own-work blind spot that crew (external CLIs) + Scrooge
// (real $) don't cover. Fail-silent: never break the parent session.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { resolveProject, hostId } from "../lib/project.mjs";
import { notionalCost } from "./pricing.mjs";
import { isSubagentTranscript, isImplausibleCost } from "./lib/subagent-cost-lib.mjs";

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

// Resolve the sub-agent's OWN transcript: the payload path ONLY if it's truly a sub-agent transcript,
// else reconstruct from the subagents tree (which can only ever find real agent-*.jsonl), else "".
function findTranscript(input) {
  const direct = input.transcript_path;
  if (direct && existsSync(direct) && isSubagentTranscript(direct)) return direct;
  const sid = input.session_id, aid = input.agent_id;
  // search the session's subagents tree (plain Task → subagents/agent-<id>.jsonl; Workflow → subagents/workflows/<wf>/agent-<id>.jsonl)
  const roots = [];
  try {
    const base = join(homedir(), ".claude", "projects");
    for (const proj of readdirSync(base)) {
      const sdir = join(base, proj, sid || "", "subagents");
      if (sid && existsSync(sdir)) roots.push(sdir);
    }
  } catch {}
  let best = "", bestM = 0;
  const walk = dir => { let ents = []; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /^agent-.*\.jsonl$/.test(e.name)) {
        if (aid && e.name.includes(aid)) return (best = p, bestM = Infinity); // exact id wins
        try { const m = statSync(p).mtimeMs; if (m > bestM) { best = p; bestM = m; } } catch {}
      }
    }
  };
  for (const r of roots) walk(r);
  return best || "";
}

function usageRows(file) {
  const rows = [];
  let firstUserText = "";
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (!firstUserText && r.type === "user" && r.message) {
        const c = r.message.content;
        firstUserText = (typeof c === "string" ? c : Array.isArray(c) ? c.filter(b => b?.type === "text").map(b => b.text).join(" ") : "").trim();
      }
      const u = r?.message?.usage;
      if (r.type === "assistant" && u) rows.push({
        model: r.message.model || "",
        input: u.input_tokens || 0, output: u.output_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0,
      });
    }
  } catch {}
  return { rows, firstUserText };
}

try {
  const input = JSON.parse((await readStdin()) || "{}");
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const project = resolveProject(cwd);
  const agentType = String(input.agent_type || "subagent").slice(0, 40);
  const effort = input.effort?.level || "";

  const file = findTranscript(input);
  if (!file) { process.stderr.write("[trantor] subagent-cost: no transcript found\n"); process.stdout.write("{}"); process.exit(0); }
  const { rows, firstUserText } = usageRows(file);
  const ttl = process.env.TRANTOR_CACHE_TTL === "1h" ? "1h" : "5m";
  const { usd, tokens, unpriced, model } = notionalCost(rows, ttl);

  // Sanity guard: a single sub-agent with >50M cache-read (or >$50 notional) is almost certainly a
  // mis-resolved transcript (e.g. a parent session summed in). Don't card a bogus cost — better a card
  // with no $ than one claiming thousands. (Real agents top out ~40M cache-read / ~$30; see the v0.17.37 fix.)
  const totalCacheRead = (tokens?.cacheRead || 0);
  const suspect = isImplausibleCost({ usd, cacheRead: totalCacheRead });
  const safeUsd = suspect ? null : usd;
  const safeNote = suspect ? "skipped-implausible-cost (likely mis-resolved transcript)" : (usd == null ? "usage-unavailable-or-unpriced" : (unpriced ? `${unpriced} turn(s) unpriced` : ""));
  if (suspect) process.stderr.write(`[trantor] subagent-cost: SKIPPED implausible cost ($${usd?.toFixed?.(0)}, ${(totalCacheRead/1e6).toFixed(0)}M cache-read) — ${basename(file)}\n`);

  const task = (firstUserText || agentType).replace(/\s+/g, " ").slice(0, 90);
  const title = `${agentType}: ${task}`.slice(0, 180);
  const costNote = usd == null ? "usage-unavailable-or-unpriced" : (unpriced ? `${unpriced} turn(s) unpriced` : "");

  await fetch(`${relayUrl()}/task`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project, title, status: "done",
      assignee: `${agentType}:${project}`, by: `${hostId()}:${project}`,
      source: "cc-subagent", costKind: "subagent-notional",
      costUsd: safeUsd, costNote: safeNote, model, effort, tokens: suspect ? null : tokens,
      phase: "sub-agents",
    }),
    signal: AbortSignal.timeout(2500),
  }).catch(() => {});
  process.stderr.write(`[trantor] subagent-cost: ${agentType} ${model} ~$${usd == null ? "?" : usd.toFixed(4)} (${tokens.input + tokens.output + tokens.cacheWrite + tokens.cacheRead} tok) → ${project}\n`);
  // surface it back to the parent's Claude inline
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SubagentStop", additionalContext: `[trantor] logged sub-agent ${agentType} — notional $${usd == null ? "?" : usd.toFixed(4)}` } }));
} catch (e) {
  process.stderr.write(`[trantor] subagent-cost error: ${e?.message || e}\n`);
  process.stdout.write("{}");
}
process.exit(0);

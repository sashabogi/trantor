#!/usr/bin/env node
// trantor SubagentStop hook — Kimi Code port. When a Kimi sub-agent (Agent/AgentSwarm tool)
// finishes, flip its in-flight card to "done", tagged with the NOTIONAL API cost of its token
// usage. Kimi's SubagentStop payload field names are undocumented (read defensively), and its
// wire.jsonl usage rows use {inputOther, output, inputCacheRead, inputCacheCreation} — mapped here
// to the pricing lib's row shape. Models the pricing table doesn't know (e.g. kimi-code/*) simply
// card with costNote "usage-unavailable-or-unpriced" — the board still shows the completed work.
// Fail-silent: never break the parent session.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { readPayload, payloadCwd, isHomeSession, identity, relayUrl, debugHook, hostId } from "./lib/common.mjs";
import { notionalCost } from "../../hooks/pricing.mjs";
import { isImplausibleCost } from "../../hooks/lib/subagent-cost-lib.mjs";

const pick = (obj, keys) => { for (const k of keys) { if (obj && obj[k] != null && obj[k] !== "") return obj[k]; } return ""; };

// A real Kimi sub-agent transcript: <session>/agents/<not-main>/wire.jsonl. The MAIN agent's
// wire.jsonl is never accepted as a sub-agent's (mirrors the Claude guard).
function isKimiSubagentWire(p) {
  if (!p || !/[\/\\]wire\.jsonl$/.test(p)) return false;
  const agentDir = basename(dirname(p));
  return agentDir !== "main" && basename(dirname(dirname(p))) === "agents";
}

// Resolve the sub-agent's OWN wire.jsonl: the payload path ONLY if it's truly a sub-agent wire,
// else the newest sub-agent wire under the session's agents/ tree (matching agent id when given).
function findWire(input) {
  const direct = String(pick(input, ["transcript_path", "transcriptPath"]));
  if (direct && existsSync(direct) && isKimiSubagentWire(direct)) return direct;
  const sid = String(pick(input, ["session_id", "sessionId"]));
  const aid = String(pick(input, ["agent_id", "agentId", "subagent_id", "id"]));
  const roots = [];
  try {
    const base = join(homedir(), ".kimi-code", "sessions");
    for (const wd of readdirSync(base)) {
      const sdir = join(base, wd, sid, "agents");
      if (sid && existsSync(sdir)) roots.push(sdir);
    }
  } catch {}
  let best = "", bestM = 0;
  for (const r of roots) {
    for (const a of readdirSync(r)) {
      if (a === "main") continue;
      const w = join(r, a, "wire.jsonl");
      if (aid && a.includes(aid)) return w;   // exact id wins
      try { const m = statSync(w).mtimeMs; if (m > bestM) { best = w; bestM = m; } } catch {}
    }
  }
  return best;
}

// usage.record rows → the pricing lib's shape; also grab the sub-agent's first user prompt for
// the card title (same derivation the create path used, so the title fingerprint pairs).
function usageRows(file) {
  const rows = [];
  let firstUserText = "";
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (!firstUserText && r.type === "turn.prompt") {
        firstUserText = (Array.isArray(r.input) ? r.input : [])
          .map(p => (p && typeof p === "object" && typeof p.text === "string") ? p.text : "")
          .filter(Boolean).join(" ").trim();
      }
      if (!firstUserText && r.type === "context.append_message" && r.message?.role === "user") {
        const c = r.message.content;
        firstUserText = (typeof c === "string" ? c : Array.isArray(c) ? c.filter(b => b?.type === "text").map(b => b.text).join(" ") : "").trim();
      }
      if (r.type === "usage.record" && r.usage) {
        rows.push({
          model: r.model || "",
          input: r.usage.inputOther || 0, output: r.usage.output || 0,
          cacheWrite: r.usage.inputCacheCreation || 0, cacheRead: r.usage.inputCacheRead || 0,
        });
      }
    }
  } catch {}
  return { rows, firstUserText };
}

try {
  const payload = await readPayload();
  debugHook("SubagentStop", payload);
  const cwd = payloadCwd(payload);
  if (isHomeSession(cwd)) process.exit(0);
  const { project } = identity(cwd);
  const agentType = String(pick(payload, ["agent_type", "subagent_type", "name", "agentType"]) || "subagent").slice(0, 40);
  const agentId = String(pick(payload, ["agent_id", "agentId", "subagent_id", "id"])).slice(0, 80);
  const parent = String(pick(payload, ["parent_session_id", "parentSessionId", "session_id"])).slice(0, 120);

  const file = findWire(payload);
  if (!file) { process.stderr.write("[trantor] kimi subagent-cost: no transcript found\n"); process.exit(0); }
  const { rows, firstUserText } = usageRows(file);
  const ttl = process.env.TRANTOR_CACHE_TTL === "1h" ? "1h" : "5m";
  const { usd, tokens, unpriced, model } = rows.length
    ? notionalCost(rows, ttl)
    : { usd: null, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, unpriced: 0, model: "" };

  // Sanity guard (see the Claude port): >50M cache-read or >$50 ⇒ almost certainly a mis-resolved
  // transcript — card without a $ rather than a bogus one.
  const totalCacheRead = tokens?.cacheRead || 0;
  const suspect = rows.length ? isImplausibleCost({ usd, cacheRead: totalCacheRead }) : false;
  const safeUsd = suspect ? null : usd;
  const safeNote = suspect ? "skipped-implausible-cost (likely mis-resolved transcript)" : (usd == null ? "usage-unavailable-or-unpriced" : (unpriced ? `${unpriced} turn(s) unpriced` : ""));
  if (suspect) process.stderr.write(`[trantor] kimi subagent-cost: SKIPPED implausible cost ($${usd?.toFixed?.(0)}, ${(totalCacheRead / 1e6).toFixed(0)}M cache-read) — ${basename(file)}\n`);

  const task = (firstUserText || agentType).replace(/\s+/g, " ").slice(0, 90);
  const title = `${agentType}: ${task}`.slice(0, 180);

  await fetch(`${relayUrl()}/task`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project, title, status: "done", agentType, agentId, parent,
      assignee: `${agentType}:${project}`, by: `${hostId()}:${project}`,
      source: "cc-subagent", costKind: "subagent-notional",
      costUsd: safeUsd, costNote: safeNote, model, tokens: suspect ? null : tokens,
      phase: "sub-agents",
    }),
    signal: AbortSignal.timeout(2500),
  }).catch(() => {});
  process.stderr.write(`[trantor] kimi subagent-cost: ${agentType} ${model || "?"} ~$${usd == null ? "?" : usd.toFixed(4)} (${(tokens.input || 0) + (tokens.output || 0) + (tokens.cacheWrite || 0) + (tokens.cacheRead || 0)} tok) → ${project}\n`);
  // surface it back to the parent session inline (observation-only event — best-effort)
  process.stdout.write(`[trantor] logged sub-agent ${agentType} — notional $${usd == null ? "?" : usd.toFixed(4)}\n`);
} catch (e) {
  process.stderr.write(`[trantor] kimi subagent-cost error: ${e?.message || e}\n`);
}
process.exit(0);

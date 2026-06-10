#!/usr/bin/env node
// The Advisor — the brain's front door. Given work packages, decide HOW to execute:
// solo | scrooge | crew | hybrid — from task shape × plan economics × context horizon.
//
//   echo '{"task":"build X","packages":[{"title":"engine","difficulty":"hard"},…]}' | node bin/advise.mjs
//   node bin/advise.mjs --demo            # canned example
//
// Reads (all read-only):
//   ~/.agent-bus/profile.json             — the user's declared plans (bin/profile.mjs)
//   ~/.token-scrooge/registry.json        — Scrooge's models {cost_in, cost_out, good_for}
//   ~/.token-scrooge/capabilities.json    — per-model quality scores
// Exposed to agents as the MCP tool `relay_advise`; the crew skill calls it at kickoff.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const H = homedir();
const read = (p, fb) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fb; } };

export function loadWorld() {
  const profile = read(join(H, ".agent-bus", "profile.json"), { providers: {} });
  const registry = read(join(H, ".token-scrooge", "registry.json"), { models: {}, tasks: {} });
  const caps = read(join(H, ".token-scrooge", "capabilities.json"), {});
  const has = (c) => { try { execSync(`command -v ${c}`, { stdio: "ignore", shell: "/bin/sh" }); return true; } catch { return false; } };
  const agents = ["codex", "gemini", "kimi", "deepseek"].filter(a => has(a === "deepseek" ? "opencode" : a));
  return { profile, registry, caps, agents, scrooge: has("scrooge") };
}

const tierOf = (profile, prov) => profile?.providers?.[prov]?.tier || "api";

// pick the cheapest Scrooge model that clears the difficulty floor for a task kind
export function scroogeModelFor(registry, caps, kind = "code", difficulty = "easy") {
  const floor = { easy: 0, medium: 35, hard: 55 }[difficulty] ?? 0;
  const cands = Object.entries(registry.models || {})
    .filter(([, m]) => (m.good_for || []).includes(kind))
    .filter(([id]) => (caps[id]?.coding ?? caps[id]?.intelligence ?? 40) >= floor)
    .sort((a, b) => (a[1].cost_in + a[1].cost_out) - (b[1].cost_in + b[1].cost_out));
  return cands[0] ? { model: cands[0][0], cost_in: cands[0][1].cost_in, cost_out: cands[0][1].cost_out } : null;
}

// crude per-package token forecast (input+output through the executor)
const FORECAST = { easy: 0.3e6, medium: 1.5e6, hard: 6e6 };  // tokens
// crew agent preference per difficulty: frontier subs take hard, cheap takes easy
const CREW_PREF = { hard: ["codex", "gemini", "kimi", "deepseek"], medium: ["kimi", "gemini", "codex", "deepseek"], easy: ["deepseek", "kimi", "gemini", "codex"] };

export function advise(input, world = loadWorld()) {
  const { profile, registry, caps, agents, scrooge } = world;
  const pkgs = (input.packages || []).map(p => ({ title: p.title || "work", difficulty: ["easy", "medium", "hard"].includes(p.difficulty) ? p.difficulty : "medium", kind: p.kind || "code" }));
  const horizon = input.horizon || (pkgs.length >= 4 ? "long" : pkgs.length >= 2 ? "medium" : "short");
  const orchTier = tierOf(profile, "claude");
  const n = pkgs.length, hard = pkgs.filter(p => p.difficulty === "hard").length, easy = pkgs.filter(p => p.difficulty === "easy").length;

  // ---- mode decision ----
  let mode, why = [];
  if (n <= 1 && hard === 0 && horizon === "short") {
    if (n === 1 && pkgs[0].difficulty === "easy" && scrooge) { mode = "scrooge"; why.push("single small stateless package — a cheap inline call beats spinning up anything"); }
    else { mode = "solo"; why.push("one small package, short horizon — orchestrator handles it directly"); }
  } else if (orchTier === "api") {
    mode = "crew"; why.push("orchestrator is API-billed: every token here is money — be a thin foreman, run all work on crew quotas + Scrooge");
  } else if (orchTier === "capped-sub" && n >= 2) {
    mode = "crew"; why.push("orchestrator is on a capped plan: a real build can't fit in this session — spend the scarce budget on architecture + verification only");
  } else if (n >= 3 || hard >= 1 || horizon === "long") {
    mode = "crew"; why.push(`${n} packages${hard ? `, ${hard} hard` : ""}, ${horizon} horizon — crew isolates work in separate contexts so this session burns at coordination rate, not work rate`);
  } else {
    mode = "solo"; why.push("small enough to do inline without hurting the context horizon");
  }
  // hybrid: crew + easy packages that should be scrooge'd instead of occupying an agent
  if (mode === "crew" && easy > 0 && scrooge) { mode = "hybrid"; why.push(`${easy} easy package(s) routed to Scrooge inline — don't burn a crew seat on grunt work`); }

  // ---- routing per package ----
  const used = {};
  const routing = pkgs.map(p => {
    if ((mode === "hybrid" || mode === "scrooge") && p.difficulty === "easy" && scrooge) {
      const m = scroogeModelFor(registry, caps, p.kind, p.difficulty);
      const tok = FORECAST.easy;
      const cost = m ? +(tok * 0.6 * m.cost_in / 1e6 + tok * 0.4 * m.cost_out / 1e6).toFixed(3) : null;
      return { ...p, executor: "scrooge", model: m?.model, pool: "api", est_cost_usd: cost,
        reason: `easy + stateless → cheapest capable model (${m?.model}); not worth a crew seat` };
    }
    if (mode === "solo") return { ...p, executor: "orchestrator", pool: tierOf(profile, "claude"), reason: "small enough to do inline" };
    const pref = CREW_PREF[p.difficulty].filter(a => agents.includes(a));
    const agent = pref.sort((a, b) => (used[a] || 0) - (used[b] || 0))[0] || "deepseek";
    used[agent] = (used[agent] || 0) + 1;
    const pool = tierOf(profile, agent === "deepseek" ? "deepseek" : agent);
    let est = null;
    if (pool === "api") { // deepseek API etc — estimate real $ via registry
      const m = registry.models?.["deepseek-v4-flash"] || { cost_in: 0.14, cost_out: 0.28 };
      est = +((FORECAST[p.difficulty] * 0.85 * m.cost_in + FORECAST[p.difficulty] * 0.15 * m.cost_out) / 1e6).toFixed(2);
    }
    const why_r = p.difficulty === "hard"
      ? `hard → strongest available coder (${agent}); its ${pool} pool means ${pool === "api" ? "real $ but cheapest capable" : "$0 marginal on existing quota"}`
      : p.difficulty === "medium"
        ? `medium → solid mid-tier (${agent}) keeps frontier seats free for hard work; ${pool === "api" ? "metered" : "quota"} pool`
        : `easy → cheapest seat (${agent})`;
    return { ...p, executor: agent, pool, est_cost_usd: est, reason: why_r };
  });
  // crew-size rationale: seats are EMERGENT from the work, and we say so
  const seats = [...new Set(routing.filter(r => !["scrooge", "orchestrator"].includes(r.executor)).map(r => r.executor))];
  const crew = {
    seats: seats.length, of_available: agents.length, members: seats,
    why: seats.length === 0 ? "no crew needed" :
      `${routing.filter(r => seats.includes(r.executor)).length} crew-bound package(s) → ${seats.length} seat(s), one per concurrent work stream (load-balanced); ${agents.length - seats.length > 0 ? `${agents.length - seats.length} installed CLI(s) left idle — seats follow the work, not the install list` : "all installed CLIs engaged because the work fans that wide"}`
  };

  const apiCost = +(routing.reduce((s, r) => s + (r.est_cost_usd || 0), 0)).toFixed(2);
  const pools = [...new Set(routing.map(r => `${r.executor}:${r.pool}`))];
  const summary =
    `Recommendation: ${mode.toUpperCase()}. ${why.join("; ")}. ` +
    (mode === "crew" || mode === "hybrid"
      ? `Routing: ${routing.map(r => `${r.title}→${r.executor}${r.model ? `(${r.model})` : ""}`).join(", ")}. ` +
        `Estimated real-money cost ≈ $${apiCost} (everything on a subscription pool is $0 marginal — quota pooling across ${pools.length} pools).`
      : "");
  return { mode, why, crew, routing, est_api_cost_usd: apiCost, quota_pools: pools, summary, orchestrator_tier: orchTier, agents_available: agents };
}

// ---- CLI ----
if (import.meta.url === `file://${process.argv[1]}`) {
  let input;
  if (process.argv.includes("--demo")) {
    input = { task: "neon asteroids game", packages: [
      { title: "engine+integration", difficulty: "hard" }, { title: "render/bloom", difficulty: "hard" },
      { title: "combat+ui", difficulty: "medium" }, { title: "audio", difficulty: "medium" },
      { title: "readme+badges", difficulty: "easy" } ] };
  } else {
    const stdin = readFileSync(0, "utf8").trim();
    input = stdin ? JSON.parse(stdin) : { packages: [] };
  }
  const out = advise(input);
  console.log(JSON.stringify(out, null, 2));
}

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
import { pathToFileURL } from "node:url";

const H = homedir();
const read = (p, fb) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fb; } };

// ---- crew roster: BUILT-IN seats + ANY opencode provider the user has brought (BYOM) ----
// Each seat: the CLI binary that must exist (`cli`) · the `trantor up` LAUNCH spec · the bus
// SESSION label (its identity on the board) · the profile PROVIDER key (tier/cost) · for
// opencode-driven seats, the opencode PROVIDER id (`providerOc`) used to enumerate models + auth.
//
// GEMINI is deliberately absent: Google retired the free CLI seat (2026-06-18) → `gemini --yolo`
// crashes exit 1. Its replacement is GLM via opencode.
//
// The opencode-driven seats are the BYOM substrate: opencode is a UNIVERSAL adapter, so any
// provider the user configures in opencode (or declares in their profile) becomes a crew seat
// with ZERO code change here — `buildRoster()` discovers them at runtime. The built-ins below are
// just the curated defaults + the two opencode seats with non-obvious mappings (glm: profile key
// `zai` ↔ opencode provider `zai-coding-plan`).
export const BUILTIN_ROSTER = {
  codex:      { cli: "codex",    launch: "codex",                   session: "codex",      provider: "codex" },
  kimi:       { cli: "kimi",     launch: "kimi",                    session: "kimi",       provider: "kimi" },
  deepseek:   { cli: "opencode", launch: "deepseek:deepseek",       session: "deepseek",   provider: "deepseek",   providerOc: "deepseek" },
  glm:        { cli: "opencode", launch: "glm:zai-coding-plan",      session: "glm",        provider: "zai",        providerOc: "zai-coding-plan" },
  openrouter: { cli: "opencode", launch: "openrouter:openrouter",   session: "openrouter", provider: "openrouter", providerOc: "openrouter" },
};
// opencode provider ids already claimed by a built-in (so discovery never duplicates them) + the
// names that are native CLIs / built-in profile aliases (never opencode-driven seats).
const BUILTIN_OC = new Set(Object.values(BUILTIN_ROSTER).filter(s => s.providerOc).map(s => s.providerOc));
const NEVER_DISCOVER = new Set(["claude", "codex", "kimi", "gemini", "zai", "opencode"]);

// Discover opencode providers the user has configured — from opencode.json `provider` keys AND
// from profile providers declared via `trantor provider add` — that aren't already built-in. Each
// becomes an opencode-driven seat under its OWN bus label (distinct session, no collisions). THIS
// is what lets a brought provider (Inception, a Japanese model, any opencode vendor) light up a
// seat with no code edit. T2's capability ingestion then makes it route well by difficulty.
export function discoverSeats(profile, ocConfig) {
  const out = {};
  const provKeys = new Set([...Object.keys(ocConfig?.provider || {}), ...Object.keys(profile?.providers || {})]);
  for (const p of provKeys) {
    if (BUILTIN_OC.has(p) || NEVER_DISCOVER.has(p)) continue;
    const label = String(p).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    out[label] = { cli: "opencode", launch: `${label}:${p}`, session: label, provider: p, providerOc: p, discovered: true };
  }
  return out;
}

export function buildRoster(profile, ocConfig) {
  return { ...BUILTIN_ROSTER, ...discoverSeats(profile, ocConfig) };
}

export function loadWorld() {
  const profile = read(join(H, ".agent-bus", "profile.json"), { providers: {} });
  const registry = read(join(H, ".token-scrooge", "registry.json"), { models: {}, tasks: {} });
  const caps = read(join(H, ".token-scrooge", "capabilities.json"), {});
  const ocConfig = read(join(H, ".config", "opencode", "opencode.json"), {});
  const roster = buildRoster(profile, ocConfig);
  const has = (c) => { try { execSync(`command -v ${c}`, { stdio: "ignore", shell: "/bin/sh" }); return true; } catch { return false; } };
  const opencodeKey = (prov) => !!ocConfig?.provider?.[prov]?.options?.apiKey;
  // a key the user already has for Scrooge counts too — the opencode runner sources these .env
  // files, so e.g. OPENROUTER_API_KEY in ~/.token-scrooge/.env lights up the seat with no extra setup.
  const envHasKey = (k) => !!process.env[k] || [join(H, ".token-scrooge", ".env"), join(H, ".agent-bus", ".env")]
    .some(f => { try { return readFileSync(f, "utf8").includes(k); } catch { return false; } });
  // a seat is available only if its CLI exists AND (for opencode-driven seats) the provider is
  // actually set up — a present binary with a dead/missing seat must NOT be recommended.
  const hasSeat = (tok) => {
    const s = roster[tok]; if (!s || !has(s.cli)) return false;
    if (s.cli !== "opencode") return true;                       // native CLI present = ready
    const envKey = `${String(s.providerOc).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
    return opencodeKey(s.providerOc) || envHasKey(envKey) || !!profile?.providers?.[s.provider];
  };
  const agents = Object.keys(roster).filter(hasSeat);
  return { profile, registry, caps, roster, agents, scrooge: has("scrooge") };
}

const tierOf = (profile, prov) => profile?.providers?.[prov]?.tier || "api";

const FLASH_TIER = /(flash|turbo|lite|mini|highspeed|small)/i;

// pick the cheapest Scrooge model that clears the difficulty floor for a task kind
export function scroogeModelFor(registry, caps, kind = "code", difficulty = "easy") {
  const floor = { easy: 0, medium: 35, hard: 55 }[difficulty] ?? 0;
  const cands = Object.entries(registry.models || {})
    .filter(([, m]) => (m.good_for || []).includes(kind))
    .filter(([id]) => (caps[id]?.coding ?? caps[id]?.intelligence ?? 40) >= floor);
  const hard = difficulty === "hard";
  const strong = hard ? cands.filter(([id]) => !FLASH_TIER.test(id)) : cands;
  const pool = strong.length > 0 ? strong : cands;
  pool.sort((a, b) => (a[1].cost_in + a[1].cost_out) - (b[1].cost_in + b[1].cost_out));
  return pool[0] ? { model: pool[0][0], cost_in: pool[0][1].cost_in, cost_out: pool[0][1].cost_out } : null;
}

// crude per-package token forecast (input+output through the executor)
const FORECAST = { easy: 0.3e6, medium: 1.5e6, hard: 6e6 };  // tokens
// crew agent preference per difficulty: frontier subs take hard, cheap takes easy.
// (gemini retired → its slot goes to glm, a strong coding-plan seat on $0 marginal quota.)
const CREW_PREF = { hard: ["codex", "glm", "kimi", "deepseek", "openrouter"], medium: ["kimi", "glm", "codex", "deepseek", "openrouter"], easy: ["deepseek", "kimi", "glm", "codex", "openrouter"] };

export function advise(input, world = loadWorld()) {
  const { profile, registry, caps, agents, scrooge, roster = BUILTIN_ROSTER } = world;
  // brought (discovered) opencode providers extend the preference list — appended LAST in every
  // tier (unknown strength a priori, like openrouter), so they fill once the curated seats are
  // taken, and are the only option for a user who brought nothing but a custom provider.
  const broughtPref = Object.keys(roster).filter(t => roster[t].discovered && !CREW_PREF.hard.includes(t));
  const pkgs = (input.packages || []).map(p => ({ title: p.title || "work", difficulty: ["easy", "medium", "hard"].includes(p.difficulty) ? p.difficulty : "medium", kind: p.kind || "code", owner: p.owner === "self" ? "self" : (/(foundation|integration|scaffold)/i.test(p.title) ? "self" : "") }));
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
    if (p.owner === "self") return { ...p, executor: "orchestrator", pool: tierOf(profile, "claude"), reason: "architect-owned (foundation/integration doctrine) — the orchestrator keeps the shared contract in its own hands" };
    if (mode === "solo") return { ...p, executor: "orchestrator", pool: tierOf(profile, "claude"), reason: "small enough to do inline" };
    const pref = [...CREW_PREF[p.difficulty], ...broughtPref].filter(a => agents.includes(a));
    const agent = pref.sort((a, b) => (used[a] || 0) - (used[b] || 0))[0] || agents[0] || "deepseek";
    used[agent] = (used[agent] || 0) + 1;
    const pool = tierOf(profile, roster[agent]?.provider || agent);
    let est = null;
    if (pool === "api") { // deepseek API etc — estimate real $ via registry
      const m = registry.models?.["deepseek-v4-flash"] || { cost_in: 0.14, cost_out: 0.28 };
      est = +((FORECAST[p.difficulty] * 0.85 * m.cost_in + FORECAST[p.difficulty] * 0.15 * m.cost_out) / 1e6).toFixed(2);
    }
    let why_r = p.difficulty === "hard"
      ? `hard → strongest available coder (${agent}); its ${pool} pool means ${pool === "api" ? "real $ but cheapest capable" : "$0 marginal on existing quota"}`
      : p.difficulty === "medium"
        ? `medium → solid mid-tier (${agent}) keeps frontier seats free for hard work; ${pool === "api" ? "metered" : "quota"} pool`
        : `easy → cheapest seat (${agent})`;
    // OpenRouter live-select ranks capability×cost ACROSS the catalog once `scrooge-capabilities`
    // has scored it (AA scores + price proxy + per-difficulty cost weighting → hard escalates to a
    // strong model, easy stays cheap). If it hasn't been run, routing falls back to cost-only.
    if (agent === "openrouter" && p.difficulty === "hard") why_r += ` — OpenRouter ranks capability×cost; run \`scrooge-capabilities\` to keep the catalog scored (or pin openrouter:openrouter/<vendor>/<model>)`;
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
  const table = ["| package | diff | executor (model) | pool | est $ | reason |", "|---|---|---|---|---|---|",
    ...routing.map(r => `| ${r.title} | ${r.difficulty} | ${r.executor}${r.model ? ` (${r.model})` : ""} | ${r.pool} | ${r.est_cost_usd ?? "—"} | ${r.reason} |`)].join("\n");
  // card_args are born as a DAG: crew cards depend on architect-owned foundation card(s);
  // integration-titled architect cards depend on every crew card. (Indices are 1-based card
  // creation order — the architect substitutes real ids as it creates them.)
  const selfPkgs = routing.filter(r => r.executor === "orchestrator");
  const foundationIdx = selfPkgs.length ? [1] : [];
  const cards = routing.map((r, i) => {
    const seat = roster[r.executor];
    return {
    order: i + 1, title: r.title, difficulty: r.difficulty,
    // bus identity = the seat's session label (every opencode-driven seat has its OWN label, so
    // glm is `glm:<project>`, openrouter `openrouter:<project>`, a brought provider `<name>:<project>`).
    assignee: r.executor === "scrooge" || r.executor === "orchestrator" ? undefined : `${seat?.session || r.executor}:<project>`,
    // launch = the EXACT `trantor up` spec to spawn this seat; the orchestrator runs
    // `trantor up <launch> --task <task> --difficulty <difficulty>`. Carrying it explicitly is
    // what teaches the orchestrator the GLM path (`glm:zai-coding-plan`) instead of guessing.
    launch: ["scrooge", "orchestrator"].includes(r.executor) ? undefined : (seat?.launch || r.executor),
    // "auto" = resolve a LIVE model at spawn (the launch spec already pins the provider; the
    // runner picks the best live model for it). Was `<cli>-default` — a stale default.
    model: r.model || (["scrooge", "orchestrator"].includes(r.executor) ? undefined : "auto"),
    task: ["scrooge", "orchestrator"].includes(r.executor) ? undefined : r.kind,
    via: r.executor === "scrooge" ? "relay_scrooge" : "relay_task_add",
    deps_orders: r.executor === "orchestrator" && /integrat/i.test(r.title)
      ? routing.map((x, j) => j + 1).filter(j => j !== i + 1)
      : (r.executor !== "orchestrator" ? foundationIdx.filter(f => f !== i + 1) : []) };
  });
  return { mode, why, crew, routing, routing_table_md: table, card_args: cards, est_api_cost_usd: apiCost, quota_pools: pools, summary, orchestrator_tier: orchTier, agents_available: agents };
}

// ---- CLI ----
// is-main guard via PROPERLY ENCODED file URL — a hand-built `file://${argv[1]}` silently no-ops when the
// install path contains a URL-reserved char (e.g. a SPACE in ".../Application Support/..."). See profile.mjs.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
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

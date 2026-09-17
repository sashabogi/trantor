import { existsSync } from "node:fs";
import { join } from "node:path";
import { call } from "./core.mjs";
import { reapSeat } from "./state.mjs";
import { resolveEffort } from "../../lib/model-catalog.mjs";

function routeModel(ctx, provider, candidates, task, difficulty) {
  const bundled = join(ctx.root, "engine/bin/scrooge");
  const script = existsSync(bundled) ? bundled : "scrooge";
  const args = candidates
    ? [script, "route", "--candidates", candidates, "-t", task, "-d", difficulty, "--json"]
    : [script, "route", "--provider", provider, "-t", task, "-d", difficulty, "--json"];
  const result = call("python3", args, { env: ctx.env });
  if (!result.ok || !result.stdout) return "";
  try { return JSON.parse(result.stdout).qualified || ""; }
  catch { return ""; }
}

export function resolveModel(ctx, agent, provider, task, difficulty) {
  const result = call("opencode", ["models", provider], { env: ctx.env });
  const candidates = result.ok ? result.stdout.split(/\s+/).filter(Boolean).join(" ") : "";
  let model = routeModel(ctx, provider, candidates, task, difficulty);
  if (!model && candidates) {
    model = `${provider}/${candidates.split(" ")[0]}`;
    console.error(`[crew] router unavailable for ${agent}:${provider} — using the provider's own catalog head (${model})`);
  }
  if (!model) throw new Error(`[crew] live model selection failed for ${agent}:${provider} — no router and no catalog; refusing opencode global default`);
  if (model.split("/")[0] !== provider) throw new Error(`[crew] router selected ${model} outside ${provider} — refusing cross-provider fallback`);
  return model;
}

export function resolveSpec(ctx, spec, task, difficulty, skipped) {
  const [agent, ...rest] = spec.split(":");
  reapSeat(ctx, agent);
  let field = rest.join(":");
  if (!field) {
    if (agent === "glm") field = "zai-coding-plan";
    else if (!["codex", "kimi", "claude", "gemini", "dsh", "opencode"].includes(agent)) field = agent;
  }
  if (!field) {
    // #7777: CLI-default seat (kimi/codex/claude/dsh) — the catalog finds the entry through the
    // agent alias so the runner still gets a CREW_EFFORT record (or the uncatalogued line).
    return { agent, model: "", effort: resolveEffort(agent, "", difficulty) };
  }
  if (field.includes("/")) return { agent, model: field, effort: resolveEffort(agent, field, difficulty) };
  if (["claude", "codex", "kimi", "gemini"].includes(agent)) {
    console.log(`  → ${agent}: model ${field} (native pin)`);
    return { agent, model: field, effort: resolveEffort(agent, field, difficulty) };
  }
  try {
    const model = resolveModel(ctx, agent, field, task, difficulty);
    // #7777: the live model is known — attach the catalog's per-difficulty effort parameters here
    // so the runner applies them where the CLI accepts them (CREW_EFFORT, below).
    console.log(`  → ${agent}: live model ${model} (${field} · ${task}/${difficulty})`);
    return { agent, model, effort: resolveEffort(agent, model, difficulty) };
  } catch (error) {
    console.error(error.message);
    console.error(`[crew] ✗ skipping seat '${agent}' — model resolution failed for ${field} (${task}/${difficulty}); remaining seats still launch`);
    skipped.push(`${agent}: model resolution failed for ${field} (${task}/${difficulty})`);
    return null;
  }
}

export function reportSkipped(skipped) {
  if (!skipped.length) return 0;
  console.log(`\n✗✗ ${skipped.length} seat(s) skipped (model resolution failed) — the rest of the crew still launched:`);
  for (const line of skipped) console.log(`   - ${line}`);
  return 1;
}

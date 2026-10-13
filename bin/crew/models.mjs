import { existsSync } from "node:fs";
import { join } from "node:path";
import { call } from "./core.mjs";
import { resolveEffort } from "../../lib/model-catalog.mjs";

function routeModel(ctx, provider, candidates, task, difficulty) {
  const bundled = join(ctx.root, "engine/bin/scrooge");
  const script = existsSync(bundled) ? bundled : "scrooge";
  const args = candidates
    ? [script, "route", "--candidates", candidates, "-t", task, "-d", difficulty, "--json"]
    : [script, "route", "--provider", provider, "-t", task, "-d", difficulty, "--json"];
  const result = call("python3", args, { env: ctx.env });
  try {
    const decision = JSON.parse(result.stdout);
    if (decision.error) throw new Error(`[crew] router refused ${provider}: ${decision.error}`);
    return result.ok ? decision.qualified || "" : "";
  } catch (error) {
    if (error instanceof SyntaxError) return "";
    throw error;
  }
}

export function resolveModel(ctx, agent, provider, task, difficulty) {
  const result = call("opencode", ["models", provider], { env: ctx.env });
  const candidates = result.ok ? result.stdout.split(/\s+/).filter(Boolean).join(" ") : "";
  let model = routeModel(ctx, provider, candidates, task, difficulty);
  // An unavailable router must not erase seats from a layout preview. Never launch an unresolved model.
  if (!model && ctx.dry && candidates) {
    model = `${provider}/<unresolved>`;
    console.error(`[crew] dry run only for ${agent}:${provider} — router unavailable; model unresolved, live launch would be refused`);
  }
  if (!model) throw new Error(`[crew] live model selection failed for ${agent}:${provider} — no priced model matching provider preference; refusing opencode global default`);
  if (model.split("/")[0] !== provider) throw new Error(`[crew] router selected ${model} outside ${provider} — refusing cross-provider fallback`);
  return model;
}

export function resolveSpec(ctx, spec, task, difficulty, skipped) {
  const [agent, ...rest] = spec.split(":");
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
    console.log(`  → ${agent}: ${ctx.dry ? "preview" : "live"} model ${model} (${field} · ${task}/${difficulty})`);
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

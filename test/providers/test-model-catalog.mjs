#!/usr/bin/env node
// Card #7777 drills: the declarative model catalog — lookup (exact/alias/bare), effort mapping
// per API kind, the uncatalogued default, the per-CLI effort flag, and the advisor attaching
// the catalog's per-difficulty parameters to its recommendation.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const lib = await import(pathToFileURL(join(root, "lib/model-catalog.mjs")).href);
const { loadCatalog, lookup, effortParams, resolveEffort, cliEffortFlag, UNCATALOGUED_STATUS } = lib;

let passed = 0;
let failed = 0;
const check = (name, condition, detail = "") => {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

const catalog = loadCatalog();

// ---- 1. lookup: the fleet's live ids, as `trantor models` prints them ----
console.log("# lookup");
const glmFlash = lookup("zai-coding-plan/glm-5.3-flash", catalog);
check("glm seat's easy pick resolves", glmFlash.found && glmFlash.context === 1000000 && glmFlash.maxOutput === 128000, JSON.stringify(glmFlash));
check("glm entry speaks openai-chat", glmFlash.api.includes("openai-chat"), JSON.stringify(glmFlash.api));
check("glm flash carries its multimodal modalities", Array.isArray(glmFlash.modalities) && glmFlash.modalities.includes("image"), JSON.stringify(glmFlash.modalities));
check("every entry cites a source url", Object.values(catalog.models).every(m => typeof m.url === "string" && m.url.startsWith("https://")));
check("catalog is versioned", Number.isInteger(catalog.version) && catalog.version >= 1);

const deepseekPro = lookup("deepseek/deepseek-v4-pro", catalog);
check("deepseek hard pick resolves", deepseekPro.found && deepseekPro.context === 1000000, JSON.stringify(deepseekPro).slice(0, 120));
const qwenPro = lookup("qwen/deepseek-v4-pro", catalog);
check("qwen-hosted deepseek-v4-pro resolves", qwenPro.found && qwenPro.api.includes("openai-chat"), JSON.stringify(qwenPro).slice(0, 120));

// ---- 2. lookup: CLI defaults and bare ids ----
console.log("# lookup: cli defaults + bare ids");
check("kimi's CLI default resolves through its alias", lookup("kimi", catalog).id === "kimi-code/default", JSON.stringify(lookup("kimi", catalog)).slice(0, 120));
check("codex default resolves through its alias", lookup("codex", catalog).id === "codex/gpt-5.6-sol");
check("claude default resolves through its alias", lookup("claude", catalog).id === "anthropic/claude-sonnet-5");
check("bare scrooge id matches the qualified entry", lookup("deepseek-v4-flash", catalog).id === "deepseek/deepseek-v4-flash");

// ---- 3. the uncatalogued default ----
console.log("# uncatalogued default");
const ghost = lookup("openrouter/some-vendor/whoever-9", catalog);
check("uncatalogued model returns the default, not a throw", ghost.found === false);
check("default says not in catalog, provider default", ghost.status === UNCATALOGUED_STATUS, ghost.status);
check("default carries no effort", ghost.effort && Object.keys(ghost.effort).length === 0);
check("empty id also lands on the default", lookup("").found === false);

// ---- 4. effort mapping per API kind ----
console.log("# effort mapping per api kind");
check("deepseek openai-chat hard = thinking enabled + reasoning_effort max",
  JSON.stringify(effortParams("deepseek/deepseek-v4-pro", "hard", "openai-chat", catalog)) === JSON.stringify({ thinking: { type: "enabled" }, reasoning_effort: "max" }),
  JSON.stringify(effortParams("deepseek/deepseek-v4-pro", "hard", "openai-chat", catalog)));
check("deepseek anthropic-messages hard = reasoning.effort max",
  JSON.stringify(effortParams("deepseek/deepseek-v4-pro", "hard", "anthropic-messages", catalog)) === JSON.stringify({ reasoning: { effort: "max" } }),
  JSON.stringify(effortParams("deepseek/deepseek-v4-pro", "hard", "anthropic-messages", catalog)));
check("glm easy = reasoning_effort low", effortParams("zai-coding-plan/glm-5.3-flash", "easy", "openai-chat", catalog)?.reasoning_effort === "low");
check("glm hard = reasoning_effort max", effortParams("zai-coding-plan/glm-5.3", "hard", "openai-chat", catalog)?.reasoning_effort === "max");
check("codex hard = reasoning_effort high on openai-responses", effortParams("codex/gpt-5.6-sol", "hard", "openai-responses", catalog)?.reasoning_effort === "high");
check("claude easy = effort low on anthropic-messages", effortParams("anthropic/claude-sonnet-5", "easy", "anthropic-messages", catalog)?.effort === "low");
check("kimi default is catalogued but takes no effort parameters",
  JSON.stringify(effortParams("kimi-code/default", "hard", "openai-chat", catalog)) === "{}",
  JSON.stringify(effortParams("kimi-code/default", "hard", "openai-chat", catalog)));
check("unknown difficulty yields null, not a throw", effortParams("zai-coding-plan/glm-5.3", "extreme", "openai-chat", catalog) === null);
check("uncatalogued model yields null", effortParams("whoever/whatever", "hard", "openai-chat", catalog) === null);

// ---- 5. resolveEffort: the launcher-side record (agent → wire kind, alias fallback) ----
console.log("# resolveEffort");
const codexHard = resolveEffort("codex", "codex/gpt-5.6-sol", "hard", catalog);
check("codex maps to openai-responses", codexHard.found && codexHard.api === "openai-responses" && codexHard.params.reasoning_effort === "high", JSON.stringify(codexHard));
const glmEasy = resolveEffort("glm", "zai-coding-plan/glm-5.3-flash", "easy", catalog);
check("opencode seat maps to openai-chat", glmEasy.api === "openai-chat" && glmEasy.params.reasoning_effort === "low", JSON.stringify(glmEasy));
const kimiDefault = resolveEffort("kimi", "", "medium", catalog);
check("empty model id falls back to the agent alias", kimiDefault.found && kimiDefault.model === "kimi-code/default", JSON.stringify(kimiDefault));
check("kimi's record has empty params, still found", kimiDefault.found && JSON.stringify(kimiDefault.params) === "{}");
const ghostSeat = resolveEffort("dsh", "", "hard", catalog);
check("uncatalogued seat still gets a record", ghostSeat.found === false && ghostSeat.status === UNCATALOGUED_STATUS, JSON.stringify(ghostSeat));

// ---- 6. cliEffortFlag: per-CLI delivery + the one log line ----
console.log("# cli effort flag");
const codexFlag = cliEffortFlag("codex", codexHard);
check("codex carries effort as -c model_reasoning_effort", codexFlag.flag === ` -c model_reasoning_effort="high"`, codexFlag.flag);
check("codex line names the parameter set", /model_reasoning_effort=high/.test(codexFlag.text), codexFlag.text);
const glmFlag = cliEffortFlag("glm", glmEasy);
check("opencode seats carry effort as --variant", glmFlag.flag === " --variant low", glmFlag.flag);
const claudeFlag = cliEffortFlag("claude", resolveEffort("claude", "", "easy", catalog));
check("claude carries effort as --effort", claudeFlag.flag === " --effort low", claudeFlag.flag);
const kimiFlag = cliEffortFlag("kimi", kimiDefault);
check("kimi gets no flag but an honest line", kimiFlag.flag === "" && /provider default/.test(kimiFlag.text), kimiFlag.text);
const ghostFlag = cliEffortFlag("dsh", ghostSeat);
check("uncatalogued model says so on the line", ghostFlag.flag === "" && ghostFlag.text === `effort: dsh ${UNCATALOGUED_STATUS}`, ghostFlag.text);
check("no effort record means no flag and no line", JSON.stringify(cliEffortFlag("codex", null)) === JSON.stringify({ flag: "", text: "" }));

// ---- 7. the advisor attaches the catalog's per-difficulty parameters ----
console.log("# advisor attaches parameters");
const { advise } = await import(pathToFileURL(join(root, "bin/advise.mjs")).href);
const world = {
  profile: { providers: {} },
  registry: { models: { "deepseek-v4-flash": { cost_in: 0.14, cost_out: 0.28, good_for: ["code"] }, "madeup-model-9": { cost_in: 0.5, cost_out: 1.0, good_for: ["code"] } } },
  caps: {},
  agents: [],
  scrooge: true,
  roster: {},
};
const routed = advise({ task: "grunt work", packages: [{ title: "labels", difficulty: "easy", kind: "code" }], horizon: "short" }, world);
const scroogePick = routed.routing[0];
check("advisor routed the easy package to scrooge", scroogePick.executor === "scrooge" && scroogePick.model === "deepseek-v4-flash", JSON.stringify(scroogePick).slice(0, 200));
check("advisor attached catalog effort params to the pick",
  scroogePick.effort?.found === true && scroogePick.effort.params?.reasoning_effort === "low" && scroogePick.effort.difficulty === "easy",
  JSON.stringify(scroogePick.effort));
check("advisor exposes which catalog it read", routed.catalog?.version === catalog.version && /model-catalog\.json$/.test(routed.catalog.source), JSON.stringify(routed.catalog));
const ghostWorld = { ...world, registry: { models: { "madeup-model-9": { cost_in: 0.01, cost_out: 0.02, good_for: ["code"] } } } };
const ghostRouted = advise({ task: "grunt work", packages: [{ title: "labels", difficulty: "easy", kind: "code" }], horizon: "short" }, ghostWorld);
check("uncatalogued advisor pick says provider default",
  ghostRouted.routing[0].effort?.found === false && ghostRouted.routing[0].effort?.status === UNCATALOGUED_STATUS,
  JSON.stringify(ghostRouted.routing[0].effort));

// ---- 8. a corrupt catalog file degrades to the empty default ----
console.log("# corrupt catalog degrades");
const badDir = join(tmpdir(), `trantor-catalog-drill-${process.pid}`);
mkdirSync(badDir, { recursive: true });
try {
  const badPath = join(badDir, "bad.json");
  writeFileSync(badPath, "{ not json");
  const bad = loadCatalog(badPath);
  check("corrupt file reads as an empty catalog", bad.version === 0 && Object.keys(bad.models).length === 0);
  check("lookup against it still returns the default", lookup("glm", bad).found === false);
} finally {
  rmSync(badDir, { recursive: true, force: true });
}

// ---- 9. the launcher passes CREW_EFFORT through runnerCommand (dry run, no spawns) ----
console.log("# launcher passes CREW_EFFORT");
const { runnerCommand } = await import(pathToFileURL(join(root, "bin/crew/core.mjs")).href);
const ctx = { dir: "/tmp/seat", project: "catalog-drill", hub: "http://127.0.0.1:4477" };
const withEffort = runnerCommand(ctx, "glm", "zai-coding-plan/glm-5.3-flash", { found: true, agent: "glm", model: "zai-coding-plan/glm-5.3-flash", difficulty: "easy", api: "openai-chat", params: { reasoning_effort: "low" } });
check("runner command carries CREW_EFFORT json", withEffort.includes("CREW_EFFORT=") && withEffort.includes("reasoning_effort"), withEffort);
const withoutEffort = runnerCommand(ctx, "glm", "zai-coding-plan/glm-5.3-flash");
check("no effort record means no CREW_EFFORT in the command", !withoutEffort.includes("CREW_EFFORT"), withoutEffort);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

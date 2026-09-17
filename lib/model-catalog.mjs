// lib/model-catalog.mjs — the declarative model catalog (card #7777).
//
// configs/model-catalog.json records, per "<provider>/<model-id>": which API kinds it speaks,
// context window, max output, input modalities, and — the part capabilities.json does not have —
// an `effort` block mapping each crew difficulty (easy/medium/hard) to CONCRETE request
// parameters PER API KIND (reasoning_effort, thinking, effort). Scores pick WHICH model; this
// catalog says HOW to call it. A model missing from the catalog still works at its provider
// default: lookup() returns an entry whose status says "not in catalog, provider default".
//
// Model ids come from `trantor models` / the provider adapters and CLI defaults — never typed
// from memory — and every entry cites its limits with a url.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CATALOG_PATH = process.env.TRANTOR_MODEL_CATALOG || join(ROOT, "configs", "model-catalog.json");
export const UNCATALOGUED_STATUS = "not in catalog, provider default";

let CACHE;
export function loadCatalog(path = CATALOG_PATH) {
  if (CACHE && path === CATALOG_PATH) return CACHE;
  let cat;
  try { cat = JSON.parse(readFileSync(path, "utf8")); } catch { cat = null; }
  if (!cat || typeof cat !== "object") cat = { version: 0, models: {} };
  if (!cat.models || typeof cat.models !== "object") cat.models = {};
  if (path === CATALOG_PATH) CACHE = cat;
  return cat;
}

const uncatalogued = (id) => ({ found: false, id, status: UNCATALOGUED_STATUS, api: [], effort: {} });

// lookup(modelId) → the catalog entry (with found: true) or the uncatalogued default whose
// status says "not in catalog, provider default". Matching order: exact key, then a seat/CLI
// alias (kimi/codex/claude default entries carry `aliases`), then a bare id ("deepseek-v4-pro"
// matches "deepseek/deepseek-v4-pro" — scrooge routes bare ids, the runner qualified ones).
export function lookup(modelId, cat = loadCatalog()) {
  const id = String(modelId || "").trim();
  if (!id) return uncatalogued(id);
  if (cat.models[id]) return { found: true, id, ...cat.models[id] };
  for (const [key, entry] of Object.entries(cat.models)) {
    if ((entry.aliases || []).includes(id)) return { found: true, id: key, ...entry };
  }
  const lower = id.toLowerCase();
  for (const [key, entry] of Object.entries(cat.models)) {
    if (key.toLowerCase().endsWith(`/${lower}`)) return { found: true, id: key, ...entry };
  }
  return uncatalogued(id);
}

// The request parameters one difficulty level maps to for one API kind. Returns null when the
// model is uncatalogued (or the level is missing); an EMPTY object means catalogued but the
// model takes no effort parameters (provider default — e.g. K2.7 Code thinks always).
export function effortParams(modelId, difficulty, apiKind, cat = loadCatalog()) {
  const entry = lookup(modelId, cat);
  if (!entry.found) return null;
  const level = entry.effort?.[difficulty];
  if (!level) return null;
  if (apiKind && level[apiKind] !== undefined) return level[apiKind];
  const kinds = Object.keys(level);
  return kinds.length === 1 ? level[kinds[0]] : null;
}

// Which wire API kind each delivery path speaks: codex talks the OpenAI Responses API, the
// claude CLI talks anthropic-messages, every opencode-driven seat rides an openai-compatible
// chat endpoint (the glm coding plan is openai-chat only, per its provider docs).
const AGENT_API = { codex: "openai-responses", claude: "anthropic-messages", sonnet: "anthropic-messages" };
const apiOfAgent = (agent) => AGENT_API[agent] || "openai-chat";

// resolveEffort(agent, modelId, difficulty) → the launcher-side effort record that rides to the
// runner as CREW_EFFORT. modelId may be empty for a CLI-default seat (kimi/codex/claude) — the
// entry is then found through the agent alias. Always returns a record, so the runner can log
// exactly one effort line per turn.
export function resolveEffort(agent, modelId, difficulty, cat = loadCatalog()) {
  const api = apiOfAgent(agent);
  let entry = modelId ? lookup(modelId, cat) : uncatalogued("");
  if (!entry.found && agent) {
    const byAgent = lookup(agent, cat);
    if (byAgent.found) entry = byAgent;
  }
  if (!entry.found) {
    return { found: false, agent, model: modelId || agent || "", difficulty, api, status: UNCATALOGUED_STATUS };
  }
  const level = entry.effort?.[difficulty] || {};
  let params = level[api];
  if (params === undefined) {
    const kinds = Object.keys(level);
    params = kinds.length === 1 ? level[kinds[0]] : {};
  }
  return { found: true, agent, model: entry.id, difficulty, api, params: params && typeof params === "object" ? params : {} };
}

// cliEffortFlag(agent, effort) → { flag, text }: the per-CLI argument that carries the effort
// parameters, plus the ONE log line the runner prints about it. Only the parameters a CLI can
// actually carry are applied (codex: -c model_reasoning_effort; claude: --effort; opencode
// seats: --variant, opencode's provider-specific reasoning effort); anything else stays at
// provider default and the line says so.
export function cliEffortFlag(agent, effort) {
  if (!effort) return { flag: "", text: "" };
  const difficulty = effort.difficulty || "?";
  const model = effort.model || agent || "";
  if (!effort.found) return { flag: "", text: `effort: ${model} ${UNCATALOGUED_STATUS}` };
  const params = effort.params || {};
  if (agent === "codex" && params.reasoning_effort) {
    return {
      flag: ` -c model_reasoning_effort="${params.reasoning_effort}"`,
      text: `effort(${difficulty}): model_reasoning_effort=${params.reasoning_effort} set for ${model} (codex -c, catalog ${effort.api})`,
    };
  }
  if ((agent === "claude" || agent === "sonnet") && params.effort) {
    return {
      flag: ` --effort ${params.effort}`,
      text: `effort(${difficulty}): --effort ${params.effort} set for ${model} (catalog ${effort.api})`,
    };
  }
  if (params.reasoning_effort) {
    return {
      flag: ` --variant ${params.reasoning_effort}`,
      text: `effort(${difficulty}): --variant ${params.reasoning_effort} set for ${model} (opencode ${effort.api} reasoning_effort)`,
    };
  }
  return { flag: "", text: `effort(${difficulty}): ${model} in catalog — no per-request effort parameters (provider default)` };
}

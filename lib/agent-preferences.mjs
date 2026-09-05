import { execFileSync } from "node:child_process";
import { readConfig, writeConfigPublic } from "./project.mjs";
import { buildRoster, loadWorld } from "../bin/advise.mjs";

const PRESENTATION = {
  claude: { label: "Claude", homepage: "https://docs.anthropic.com/en/docs/claude-code", install: "npm install -g @anthropic-ai/claude-code", cli: "claude", launch: "claude" },
  codex: { label: "Codex", homepage: "https://developers.openai.com/codex/cli/", install: "npm install -g @openai/codex", cli: "codex", launch: "codex" },
  kimi: { label: "Kimi", homepage: "https://www.kimi.com/code/docs/en/", install: "brew install kimi-cli", cli: "kimi", launch: "kimi" },
  glm: { label: "GLM", homepage: "https://docs.z.ai/guides/develop/openai/introduction", install: "npm install -g opencode-ai", cli: "opencode", launch: "glm:zai-coding-plan" },
  deepseek: { label: "DeepSeek", homepage: "https://platform.deepseek.com/docs", install: "npm install -g opencode-ai", cli: "opencode", launch: "deepseek:deepseek" },
  openrouter: { label: "OpenRouter", homepage: "https://openrouter.ai/docs/quickstart", install: "npm install -g opencode-ai", cli: "opencode", launch: "openrouter:openrouter" },
};

export function normalizeAgentPreferences(config = {}) {
  // SAFETY: config is the JSON-decoded config.json object; only an object-shaped `agents` slice
  // may own these preferences, and every other decoded shape is treated as absent.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  const source = config.agents && typeof config.agents === "object" ? config.agents : {};
  // SAFETY: disabled is a user-editable JSON array; string entries are the complete domain and
  // malformed entries must be discarded before they reach command selection.
  const disabled = Array.isArray(source.disabled)
    ? [...new Set(source.disabled.filter(value => {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof
      return typeof value === "string" && value.trim();
    }).map(value => value.trim()))]
    : [];
  // SAFETY: default is another user-editable JSON field; a non-string cannot name an agent.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  const storedDefault = typeof source.default === "string" && source.default.trim() ? source.default.trim() : null;
  const defaultAgent = storedDefault && !disabled.includes(storedDefault) ? storedDefault : null;
  return { default: defaultAgent, disabled };
}

export function resolveAgentLaunchSpecs(specs, config = {}) {
  const preferences = normalizeAgentPreferences(config);
  const requested = specs.length ? [...specs] : preferences.default ? [preferences.default] : [];
  const disabled = requested
    .map(spec => spec.split(":")[0])
    .filter(agent => preferences.disabled.includes(agent));
  return { specs: requested, disabled };
}

export function updateAgentPreferences(config, id, update) {
  const next = structuredClone(config ?? {});
  const current = normalizeAgentPreferences(next);
  if (update.enabled !== undefined) {
    current.disabled = update.enabled
      ? current.disabled.filter(agent => agent !== id)
      : current.disabled.includes(id) ? current.disabled : [...current.disabled, id];
    if (!update.enabled && current.default === id) current.default = null;
  }
  if (update.default !== undefined) current.default = update.default ? id : null;
  next.agents = current;
  return next;
}

function commandExists(command, env = process.env) {
  try {
    execFileSync("/usr/bin/which", [command], { env, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function buildAgentSettingsStatus({ config = readConfig(), world = loadWorld(), env = process.env } = {}) {
  const preferences = normalizeAgentPreferences(config);
  const roster = buildRoster(world.profile, world.ocConfig ?? {});
  const ids = [...new Set(["claude", "codex", "kimi", "glm", "deepseek", "openrouter", ...Object.keys(roster)])];
  const agents = ids.map(id => {
    const presentation = PRESENTATION[id];
    const seat = roster[id];
    const cli = presentation?.cli ?? seat?.cli ?? "opencode";
    const label = presentation?.label ?? id.split("-").map(part => part[0]?.toUpperCase() + part.slice(1)).join(" ");
    return {
      id,
      label,
      launch: presentation?.launch ?? seat?.launch ?? id,
      cli,
      installed: commandExists(cli, env),
      enabled: !preferences.disabled.includes(id),
      isDefault: preferences.default === id,
      homepage: presentation?.homepage ?? "https://opencode.ai/docs/providers/",
      install: presentation?.install ?? "npm install -g opencode-ai",
    };
  });
  return { default: preferences.default, agents };
}

export function setAgentEnabled(id, enabled) {
  const next = updateAgentPreferences(readConfig(), id, { enabled });
  writeConfigPublic(next);
  return buildAgentSettingsStatus({ config: next });
}

export function setDefaultAgent(id) {
  const next = id ? updateAgentPreferences(readConfig(), id, { default: true }) : updateAgentPreferences(readConfig(), "", { default: false });
  writeConfigPublic(next);
  return buildAgentSettingsStatus({ config: next });
}

import assert from "node:assert/strict";
import { filterEnabledAgents } from "./bin/advise.mjs";
import { buildAgentSettingsStatus, normalizeAgentPreferences, resolveAgentLaunchSpecs, updateAgentPreferences } from "./lib/agent-preferences.mjs";

assert.deepEqual(normalizeAgentPreferences({}), { default: null, disabled: [] });
assert.deepEqual(normalizeAgentPreferences({ agents: { default: "codex", disabled: ["kimi", "kimi", ""] } }), { default: "codex", disabled: ["kimi"] });
assert.deepEqual(normalizeAgentPreferences({ agents: { default: "codex", disabled: ["codex"] } }), { default: null, disabled: ["codex"] });

assert.deepEqual(resolveAgentLaunchSpecs([], { agents: { default: "glm", disabled: [] } }), { specs: ["glm"], disabled: [] });
assert.deepEqual(resolveAgentLaunchSpecs(["codex", "glm:zai-coding-plan"], { agents: { disabled: ["glm"] } }), {
  specs: ["codex", "glm:zai-coding-plan"],
  disabled: ["glm"],
});
assert.deepEqual(filterEnabledAgents(["codex", "glm", "kimi"], { agents: { disabled: ["glm"] } }), ["codex", "kimi"]);

const disabled = updateAgentPreferences({ hubs: { trantor: "http://localhost:4477" }, agents: { default: "codex", disabled: [] } }, "codex", { enabled: false });
assert.deepEqual(disabled.agents, { default: null, disabled: ["codex"] });
assert.deepEqual(disabled.hubs, { trantor: "http://localhost:4477" });
const enabled = updateAgentPreferences(disabled, "codex", { enabled: true });
assert.deepEqual(enabled.agents, { default: null, disabled: [] });

const world = { profile: { providers: {} }, ocConfig: {}, roster: {}, agents: [] };
const pathEnv = { ...process.env, PATH: "/missing" };
const status = buildAgentSettingsStatus({ config: { agents: { default: "codex", disabled: ["kimi"] } }, world, env: pathEnv });
assert.equal(status.default, "codex");
assert.equal(status.agents.find(agent => agent.id === "codex")?.isDefault, true);
assert.equal(status.agents.find(agent => agent.id === "kimi")?.enabled, false);
assert.equal(status.agents.every(agent => agent.installed === false), true);

console.log("agent preferences: all assertions passed");

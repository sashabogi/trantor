import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crewSeats } from "../../bin/provider.mjs";
import { buildRoster } from "../../bin/advise.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const profile = { providers: {
  codex: { tier: "capped-sub" }, zai: { tier: "capped-sub" },
  deepseek: { tier: "api" }, openrouter: { tier: "api" }, lab: { tier: "api" },
} };

test("crew seat JSON shares launch specs, tiers and availability with the human roster", () => {
  const counted = [];
  const rows = crewSeats({ roster: buildRoster(profile, {}), profile, agents: ["codex", "glm", "deepseek", "lab"] }, provider => {
    counted.push(provider);
    return provider === "deepseek" ? 0 : 2;
  });
  assert.deepEqual(rows, [
    { agent: "codex", spec: "codex", tier: "capped-sub", available: true, brought: false, models: null },
    { agent: "kimi", spec: "kimi", tier: "", available: false, brought: false, models: null },
    { agent: "deepseek", spec: "deepseek:deepseek", tier: "api", available: true, brought: false, models: 0 },
    { agent: "glm", spec: "glm:zai-coding-plan", tier: "capped-sub", available: true, brought: false, models: 2 },
    { agent: "openrouter", spec: "openrouter:openrouter", tier: "api", available: false, brought: false, models: 2 },
    { agent: "lab", spec: "lab:lab", tier: "api", available: true, brought: true, models: 2 },
  ]);
  assert.deepEqual(counted, ["deepseek", "zai-coding-plan", "openrouter", "lab"]);
});

test("provider list --json emits only launchable seat rows, without status prose", () => {
  const scratch = join(root, ".agent-bus-out");
  mkdirSync(scratch, { recursive: true });
  const fixture = mkdtempSync(join(scratch, "provider-list-"));
  try {
    const bin = join(fixture, "bin");
    const bus = join(fixture, ".agent-bus");
    mkdirSync(bin);
    mkdirSync(bus);
    writeFileSync(join(bus, "profile.json"), JSON.stringify(profile));
    writeFileSync(join(bus, "config.json"), JSON.stringify({ agents: { disabled: ["openrouter"] } }));
    writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(bin, "opencode"), '#!/bin/sh\nprintf "%s/model-a\\n%s/model-b\\n" "$2" "$2"\n', { mode: 0o755 });
    const result = spawnSync(process.execPath, [join(root, "bin/provider.mjs"), "list", "--json"], {
      cwd: root, encoding: "utf8", timeout: 10000,
      env: { HOME: fixture, AGENT_BUS_DIR: bus, PATH: `${bin}:/usr/bin:/bin`, TRANTOR_SECRETS_BACKEND: "none" },
    });
    assert.equal(result.status, 0, result.stderr);
    const rows = JSON.parse(result.stdout);
    assert.deepEqual(rows.map(row => row.agent), ["codex", "kimi", "deepseek", "glm", "openrouter", "lab"]);
    assert.equal(rows.find(row => row.agent === "glm").spec, "glm:zai-coding-plan");
    assert.equal(rows.find(row => row.agent === "deepseek").models, 2);
    assert.equal(rows.find(row => row.agent === "openrouter").available, false);
    assert.equal(rows.find(row => row.agent === "lab").brought, true);
    assert.equal(rows.find(row => row.agent === "kimi").available, false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

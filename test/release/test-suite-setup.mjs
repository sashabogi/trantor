import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../..", import.meta.url));
const actionPath = "./.github/actions/suite-setup";
const action = parse(readFileSync(join(root, actionPath, "action.yml"), "utf8"));
const sharedSteps = action.runs.steps;
const workflows = ["ci", "release"].map(name => {
  const workflow = parse(readFileSync(join(root, `.github/workflows/${name}.yml`), "utf8"));
  return { name, steps: workflow.jobs[name].steps };
});

function expand(steps, shared = sharedSteps) {
  return steps.flatMap(step => step.uses === actionPath ? shared : [step]);
}

function runSetup(t, steps) {
  const out = join(root, ".agent-bus-out");
  mkdirSync(out, { recursive: true });
  const dir = mkdtempSync(join(out, "suite-setup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Stub package installation, but execute the action's actual bash scripts. The fake suite
  // requires the graft installation and rejects inherited runner identity.
  const npm = join(dir, "npm");
  writeFileSync(npm, `#!${process.execPath}
import { existsSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.some(arg => arg.startsWith('@nanonets/graft@'))) writeFileSync('graft-ready', 'yes');
if (args[0] === 'test') {
  if (!existsSync('graft-ready')) { console.error('graft missing before suite'); process.exit(1); }
  const keys = ['HERDR_ENV', 'HERDR_PANE_ID', 'TRANTOR_ORCH', 'TRANTOR_SEAT', 'RELAY_PROJECT', 'TRANTOR_PROJECT', 'RELAY_SESSION', 'RELAY_AGENT'];
  if (keys.some(key => process.env[key])) { console.error('runner identity leaked'); process.exit(1); }
  writeFileSync('suite-ran', 'yes');
}
`);
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  chmodSync(npm, 0o755);
  writeFileSync(join(dir, "pnpm"), '#!/bin/sh\nexit 0\n');
  chmodSync(join(dir, "pnpm"), 0o755);
  for (const step of steps.filter(step => step.run)) {
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], {
      cwd: dir, encoding: "utf8", timeout: 5000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RELAY_SESSION: "fixture:crew", TRANTOR_SEAT: "fixture" },
    });
    if (result.status !== 0) return { ok: false, error: result.stderr };
  }
  assert.equal(readFileSync(join(dir, "suite-ran"), "utf8"), "yes");
  return { ok: true, dir };
}

test("CI and release use the same suite setup once, after checkout", () => {
  assert.equal(action.runs.using, "composite");
  for (const { steps } of workflows) {
    const shared = steps.filter(step => step.uses === actionPath);
    assert.equal(shared.length, 1);
    assert.ok(steps.findIndex(step => step.uses?.startsWith("actions/checkout@")) < steps.indexOf(shared[0]));
    assert.equal(steps.some(step => /npm test|@nanonets\/graft|pnpm .*install/.test(step.run || "")), false);
    const all = expand(steps);
    assert.equal(all.filter(step => step.uses === "actions/setup-node@v4").length, 1);
    assert.equal(all.filter(step => step.uses === "pnpm/action-setup@v4").length, 1);
  }
  for (const step of sharedSteps.filter(step => step.run)) assert.equal(step.shell, "bash");
});

test("both shared setup paths install graft before a scrubbed suite", t => {
  for (const { steps } of workflows) {
    const shared = expand(steps.filter(step => step.uses === actionPath));
    assert.equal(runSetup(t, shared).ok, true);
  }
});

test("removing shared graft installation makes both suite paths fail", t => {
  const withoutGraft = sharedSteps.filter(step => !step.run?.includes("@nanonets/graft@"));
  for (const { steps } of workflows) {
    const shared = expand(steps.filter(step => step.uses === actionPath), withoutGraft);
    const result = runSetup(t, shared);
    assert.equal(result.ok, false);
    assert.match(result.error, /graft missing before suite/);
  }
});

test("an added shared step executes in both workflow paths", t => {
  const added = [...sharedSteps, { shell: "bash", run: "echo shared > added-step" }];
  for (const { steps } of workflows) {
    const shared = expand(steps.filter(step => step.uses === actionPath), added);
    const result = runSetup(t, shared);
    assert.equal(result.ok, true);
    assert.equal(readFileSync(join(result.dir, "added-step"), "utf8").trim(), "shared");
  }
});

// #11558: exercise the launcher and preview with isolated provider/pricing fixtures.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveModel, resolveSpec } from "../../bin/crew/models.mjs";

const root = resolve(import.meta.dirname, "../..");
mkdirSync(join(root, ".agent-bus-out"), { recursive: true });
const home = mkdtempSync(join(root, ".agent-bus-out/routing-"));
const store = join(home, ".token-scrooge");
mkdirSync(store);
mkdirSync(join(home, "bin"));
const env = { HOME: home, PATH: `${join(home, "bin")}:${process.env.PATH}`,
  SCROOGE_HOME: store, SCROOGE_ENV_FILE: "", AGENT_BUS_DIR: join(home, ".agent-bus") };
const ctx = { root, env };
const catalog = ["qwen/deepseek-v4-pro", "qwen/qwen3.8-flash", "qwen/qwen3.8-max"];
writeFileSync(join(home, "bin/opencode"), `#!/bin/sh\nprintf '%s\\n' ${catalog.map(m => `'${m}'`).join(" ")}\n`, { mode: 0o755 });
writeFileSync(join(store, "registry.json"), JSON.stringify({ models: {}, providers: {} }));
const caps = { "deepseek-v4-pro": { coding: 99 },
  "qwen3.8-flash": { coding: 60, cost_in: 0.1, cost_out: 0.2 },
  "qwen3.8-max": { coding: 76.2, cost_in: 2, cost_out: 6 } };
const save = () => writeFileSync(join(store, "capabilities.json"), JSON.stringify(caps));
function route(candidates, difficulty = "hard") {
  return spawnSync("python3", [join(root, "engine/bin/scrooge"), "route", "--candidates",
    candidates.join(" "), "-d", difficulty, "--json"], { env, encoding: "utf8", cwd: root });
}
try {
  save();
  for (const difficulty of ["easy", "medium", "hard"]) {
    const expected = `qwen/qwen3.8-${difficulty === "hard" ? "max" : "flash"}`;
    assert.equal(resolveModel(ctx, "qwen", "qwen", "code", difficulty), expected);
    assert.equal(resolveSpec(ctx, "qwen", "code", difficulty, []).model, expected);
  }
  const preview = spawnSync(process.execPath, [join(root, "bin/models.mjs"), "qwen"], { env, encoding: "utf8", cwd: root });
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /qwen\/deepseek-v4-pro \(unpriced\)/);
  for (const difficulty of ["easy", "medium", "hard"]) {
    assert.match(preview.stdout, new RegExp(`${difficulty} +→ qwen/qwen3.8-${difficulty === "hard" ? "max" : "flash"}`));
  }
  caps["unpriced-v99"] = { coding: 100 };
  save();
  const heuristic = route(["test/unpriced-v99", "test/qwen3.8-max"]);
  assert.equal(heuristic.status, 0, heuristic.stderr);
  assert.equal(JSON.parse(heuristic.stdout).qualified, "test/qwen3.8-max");
  assert.deepEqual(JSON.parse(heuristic.stdout).unpriced, ["unpriced-v99"]);
  assert.equal(route(["test/unpriced-v99"]).status, 2);
  delete caps["qwen3.8-flash"].cost_out;
  save();
  assert.throws(() => resolveModel(ctx, "qwen", "qwen", "code", "easy"), /no priced candidate/);
  assert.equal(resolveSpec(ctx, "qwen:qwen/deepseek-v4-pro", "code", "easy", []).model, "qwen/deepseek-v4-pro");
  assert.throws(() => resolveModel({ ...ctx, dry: true }, "qwen", "qwen", "code", "easy"), /no priced candidate/);
  rmSync(join(store, "registry.json"));
  assert.equal(resolveModel({ ...ctx, dry: true }, "qwen", "qwen", "code", "easy"), "qwen/<unresolved>");
  assert.throws(() => resolveModel(ctx, "qwen", "qwen", "code", "easy"), /no priced model/);
  console.log("PASS: Qwen launcher and preview, unpriced exclusion, heuristic guard, refusal and explicit override");
} finally {
  rmSync(home, { recursive: true, force: true });
}

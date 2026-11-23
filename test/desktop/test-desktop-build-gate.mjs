import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GATE = join(ROOT, "bin", "desktop-build-gate.mjs");
const OUT = join(ROOT, ".agent-bus-out");

test("the desktop build gate runs a locked release check and propagates failure", t => {
  mkdirSync(OUT, { recursive: true });
  const dir = mkdtempSync(join(OUT, "desktop-build-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const argsFile = join(dir, "cargo-args.json");
  mkdirSync(bin);
  writeFileSync(join(bin, "cargo"), `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.exit(42);
`, { mode: 0o755 });

  const result = spawnSync(process.execPath, [GATE], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: "utf8",
  });
  assert.equal(result.status, 42, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(argsFile, "utf8")), [
    "check", "--release", "--locked", "--manifest-path", "desktop/src-tauri/Cargo.toml",
  ]);
});

test("the shared suite and CI both run the desktop build gate", () => {
  const runner = readFileSync(join(ROOT, "test", "run.mjs"), "utf8");
  const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(runner, /rel: "desktop-build-gate", lane: "gate", cmd: \["node", \["bin\/desktop-build-gate\.mjs"\]\]/);
  assert.match(ci, /run: node bin\/desktop-build-gate\.mjs/);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkTauriVersionParity } from "../../lib/tauri-version-parity.mjs";

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
  assert.match(runner, /CARGO_HOME.*RUSTUP_HOME/s);
  assert.match(ci, /run: node bin\/desktop-build-gate\.mjs/);
});

function parityFixture(t, { cargoVersion = "2.4.1", npmVersion = cargoVersion, npmOnly = false } = {}) {
  mkdirSync(OUT, { recursive: true });
  const dir = mkdtempSync(join(OUT, "tauri-parity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "src-tauri"));
  writeFileSync(join(dir, "src-tauri", "Cargo.toml"), `[dependencies]
tauri = "2"
tauri-plugin-window-state = "2"
`);
  writeFileSync(join(dir, "src-tauri", "Cargo.lock"), `[[package]]
name = "tauri"
version = "2.11.5"

[[package]]
name = "tauri-plugin-window-state"
version = "${cargoVersion}"
`);
  const dependencies = {
    "@tauri-apps/api": "^2",
    "@tauri-apps/plugin-window-state": npmVersion,
  };
  if (npmOnly) dependencies["@tauri-apps/plugin-store"] = "2.0.0";
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies }));
  writeFileSync(join(dir, "pnpm-lock.yaml"), `importers:
  .:
    dependencies:
      '@tauri-apps/api':
        specifier: ^2
        version: 2.11.1
      '@tauri-apps/plugin-window-state':
        specifier: ${npmVersion}
        version: ${npmVersion}
${npmOnly ? `      '@tauri-apps/plugin-store':
        specifier: 2.0.0
        version: 2.0.0
` : ""}`);
  return dir;
}

test("matched resolved Tauri versions pass parity", t => {
  const pairs = checkTauriVersionParity(parityFixture(t));
  assert.equal(pairs.length, 2);
  assert.ok(pairs.every(pair => pair.matches));
});

test("a mismatched resolved fixture pair fails parity", t => {
  const pairs = checkTauriVersionParity(parityFixture(t, { npmVersion: "2.2.1" }));
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs.filter(pair => !pair.matches), [{
    crateName: "tauri-plugin-window-state",
    npmPackage: "@tauri-apps/plugin-window-state",
    cargoVersion: "2.4.1",
    npmVersion: "2.2.1",
    matches: false,
  }]);
});

test("an npm Tauri plugin with no Rust twin is ignored", t => {
  const pairs = checkTauriVersionParity(parityFixture(t, { npmOnly: true }));
  assert.equal(pairs.length, 2);
  assert.ok(pairs.every(pair => pair.matches));
});

test("the desktop checkout has matching resolved Tauri versions", () => {
  const pairs = checkTauriVersionParity(join(ROOT, "desktop"));
  assert.ok(pairs.length >= 3);
  assert.deepEqual(pairs.filter(pair => !pair.matches), []);
});

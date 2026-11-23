#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkTauriVersionParity } from "../lib/tauri-version-parity.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
let parity;
try {
  parity = checkTauriVersionParity(join(ROOT, "desktop"));
} catch (error) {
  console.error(`desktop-build-gate: ${error.message}`);
  process.exit(1);
}
const mismatches = parity.filter(pair => !pair.matches);
for (const pair of mismatches) {
  console.error(`desktop-build-gate: ${pair.crateName} ${pair.cargoVersion} != ${pair.npmPackage} ${pair.npmVersion}; major.minor must match`);
}
if (mismatches.length) process.exit(1);
console.log(`Tauri version parity: ${parity.length} pair${parity.length === 1 ? "" : "s"} matched`);

const result = spawnSync(process.execPath, [
  join(ROOT, "bin", "cargo-gate.mjs"),
  "check",
  "--release",
  "--locked",
  "--manifest-path",
  "desktop/src-tauri/Cargo.toml",
], { cwd: ROOT, stdio: "inherit" });

if (result.error) {
  console.error(`desktop-build-gate: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);

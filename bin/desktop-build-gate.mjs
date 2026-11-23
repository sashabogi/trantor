#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
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

#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const result = spawnSync("python3", [join(import.meta.dirname, "heavy-gate.py"), ...args], { stdio: "inherit" });
if (result.error) {
  console.error(`heavy-gate: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) process.exit(128 + (constants.signals[result.signal] || 0));
process.exit(result.status ?? 1);

#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const shimDir = resolve(import.meta.dirname, "heavy-gate-shim");
const path = (process.env.PATH || "").split(":").filter(entry => resolve(entry) !== shimDir).join(":");
const env = { ...process.env, PATH: path };
const heavy = args.includes("test") || args.includes("build");
const result = heavy
  ? spawnSync(process.execPath, [join(import.meta.dirname, "heavy-gate.mjs"), "--", "cargo", ...args], { env, stdio: "inherit" })
  : spawnSync("cargo", args, { env, stdio: "inherit" });
if (result.error) {
  console.error(`cargo-gate: ${result.error.message}`);
  process.exit(127);
}
if (result.signal) process.exit(128 + (constants.signals[result.signal] || 0));
process.exit(result.status ?? 1);

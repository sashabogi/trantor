#!/usr/bin/env node
// 0.18.93 shipped memory pins that worked from the CLI and silently did nothing from the plugin:
// the plugin snapshot has no node_modules, `yaml` failed to import, and the session-start worker
// swallowed it. Run the session-start line from a node_modules-free copy of the code.
import "../isolate-bus.mjs";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fingerprint } from "../../lib/memory-pins.mjs";

const root = resolve(".");
// Outside the checkout: anywhere under it, node would find the repo's own node_modules by walking up.
const work = mkdtempSync(join(realpathSync("/tmp"), "trantor-snapshot-deps-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));
const snapshot = join(work, "plugin");
for (const dir of ["lib", "hooks"]) cpSync(join(root, dir), join(snapshot, dir), { recursive: true });
writeFileSync(join(snapshot, "package.json"), JSON.stringify({ type: "module" }));
// A global prefix whose lib/node_modules/trantor is this checkout, as `npm i -g trantor` leaves it.
const prefix = join(work, "prefix");
mkdirSync(join(prefix, "lib", "node_modules"), { recursive: true });
symlinkSync(root, join(prefix, "lib", "node_modules", "trantor"));

const project = join(work, "proj");
mkdirSync(project);
assert.equal(spawnSync("git", ["init", "-q", project]).status, 0);
writeFileSync(join(project, "a.mjs"), "export function alpha(x) {\n  return x + 2;\n}\n");
assert.equal(spawnSync("graft", ["build", project, "--no-gitignore", "--no-ignore"]).status, 0, "graft build");
const config = join(work, "config");
const memory = join(config, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
mkdirSync(memory, { recursive: true });
const pinned = fingerprint("export function alpha(x) {\n  return x + 1;\n}");
writeFileSync(join(memory, "note.md"), `---\nname: note\npins:\n  - symbol: a.mjs#alpha\n    fp: ${pinned}\n---\nalpha adds one.\n`);

// A script file, not --input-type: the session-start worker inherits the parent's execArgv.
const probe = join(snapshot, "probe.mjs");
writeFileSync(probe, `const m = await import("./hooks/lib/memory-start.mjs"); console.log(JSON.stringify(await m.memoryStartLine(${JSON.stringify(project)})));`);
const run = spawnSync(process.execPath, [probe], {
  cwd: work, encoding: "utf8",
  env: { ...process.env, CLAUDE_CONFIG_DIR: config, npm_config_prefix: prefix, NODE_PATH: "" },
});
let line = "";
try { line = JSON.parse(run.stdout.trim().split("\n").pop()); } catch {}
const ok = /1 stale, 0 broken notes: note\.md/.test(line);
console.log(`${ok ? "PASS" : "FAIL"}  a node_modules-free plugin snapshot still names the stale note at session start  ${JSON.stringify(line)} ${run.stderr.slice(0, 300)}`);
process.exit(ok ? 0 : 1);

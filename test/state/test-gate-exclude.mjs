#!/usr/bin/env node
// lib/state/gate.mjs ensureIgnored used dirname without importing it, so the scratch dir was never excluded and the memo never hit.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { contentHash } from "../../lib/state/gate.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ""}`); } };

const dir = mkdtempSync(join(tmpdir(), "trantor-gate-exclude-"));
try {
  spawnSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "x\n");
  const h1 = contentHash(dir);
  const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
  ok("contentHash adds .agent-bus-out/ to the repo's local excludes", exclude.split("\n").includes(".agent-bus-out/"), JSON.stringify(exclude.slice(-80)));
  writeFileSync(join(dir, ".agent-bus-out", "noise.txt"), "scratch\n");
  ok("scratch files do not change the content hash", contentHash(dir) === h1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

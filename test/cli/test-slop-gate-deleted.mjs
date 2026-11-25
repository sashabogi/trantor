#!/usr/bin/env node
// The slop gate reads every changed file, so a change that DELETES a file crashed it with ENOENT
// before any verdict (found removing dead views for #14109). A deletion has nothing to lint.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = fileURLToPath(new URL("../../bin/slop-gate.mjs", import.meta.url));
let failed = 0;
const ok = (name, cond) => { console.log(`${cond ? "  ✓" : "  ✗"} ${name}`); if (!cond) failed++; };
const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });

const repo = mkdtempSync(join(tmpdir(), "trantor-slop-deleted-"));
try {
  git(["init", "-q", "-b", "main"], repo);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "gone.ts"), "export const gone = 1;\n");
  writeFileSync(join(repo, "src", "kept.txt"), "kept\n");
  git(["add", "-A"], repo);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], repo);
  rmSync(join(repo, "src", "gone.ts"));

  const run = spawnSync("node", [GATE], { cwd: repo, encoding: "utf8" });
  const out = `${run.stdout}${run.stderr}`;
  console.log("slop-gate with a deleted file in the change");
  ok("it does not crash on the missing file", !/ENOENT/.test(out));
  ok("it exits 0: a deletion alone is nothing to lint", run.status === 0);
  ok("and says there is nothing lintable", /no lintable changes/.test(out));
} finally {
  rmSync(repo, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

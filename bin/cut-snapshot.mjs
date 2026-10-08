#!/usr/bin/env node
// The shell calls this before every destructive turn sweep (#10497).
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function snapshotBeforeCut(workDir, reason = "stall") {
  const git = args => {
    const r = spawnSync("git", args, { cwd: workDir, encoding: "utf8", timeout: 20000 });
    if (r.status !== 0) throw new Error(String(r.stderr || r.error || "git failed").trim());
    return r.stdout;
  };
  try {
    // Never capture a parent checkout when a CLI was launched in a nested scratch directory.
    const top = git(["rev-parse", "--show-toplevel"]).trim();
    if (realpathSync(top) !== realpathSync(workDir)) return { ok: true, files: 0 };
    const branch = git(["symbolic-ref", "--short", "HEAD"]).trim();
    const status = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (!status) return { ok: true, files: 0 };
    if (!branch.startsWith("seat/")) return { ok: false, error: `dirty branch ${branch} is not a seat branch` };
    let files = 0;
    const rows = status.split("\0");
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i]) continue;
      files++;
      if (/^[RC]|^.[RC]/.test(rows[i])) i++;
    }
    git(["add", "-A"]);
    git(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-m", `wip: cut at ${reason}, ${files} files`]);
    return { ok: true, files, sha: git(["rev-parse", "HEAD"]).trim() };
  } catch (e) { return { ok: false, error: e.message }; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = snapshotBeforeCut(process.argv[2], process.argv[3]);
  if (!result.ok) console.error(`cut snapshot failed: ${result.error}`);
  process.exit(result.ok ? 0 : 1);
}

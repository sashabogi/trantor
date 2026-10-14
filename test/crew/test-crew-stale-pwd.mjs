import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { workingDir } from "../../bin/crew/core.mjs";

// The app relaunched from a trantor shell kept PWD=<trantor> and spawned `trantor open crebral`
// with cwd=<crebral>: open read PWD, decided it stood in trantor, and refused the handoff.
const out = resolve(".agent-bus-out");
mkdirSync(out, { recursive: true });
const root = mkdtempSync(join(out, "crew-stale-pwd-"));
const repo = name => {
  const dir = join(root, name);
  mkdirSync(dir);
  spawnSync("git", ["init", "-q", dir]);
  return dir;
};
try {
  const here = repo("here");
  const elsewhere = repo("elsewhere");
  const link = join(root, "here-link");
  symlinkSync(here, link);

  assert.equal(workingDir({ PWD: elsewhere }, here), here);
  console.log("ok 1 - a PWD naming another directory loses to the real cwd");
  assert.equal(workingDir({ PWD: link }, here), link);
  console.log("ok 2 - a symlinked PWD that still names the cwd keeps its spelling");
  assert.equal(workingDir({}, here), here);
  assert.equal(workingDir({ PWD: join(root, "gone") }, here), here);
  console.log("ok 3 - no PWD, or one that no longer exists, falls back to the cwd");

  const probe = `
    const { createContext } = await import(${JSON.stringify(resolve("bin/crew/core.mjs"))});
    const { resolveOrchestratorDir } = await import(${JSON.stringify(resolve("bin/crew/worktrees.mjs"))});
    const ctx = createContext("open");
    console.log(JSON.stringify(resolveOrchestratorDir(ctx, "here")));
  `;
  const env = { PATH: process.env.PATH, HOME: join(root, "home"), PWD: elsewhere };
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: here, env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout.trim().split("\n").pop()).project, "here");
  console.log("ok 4 - open spawned into a checkout with a stale PWD resolves that checkout, not the parent's");
} finally {
  rmSync(root, { recursive: true, force: true });
}

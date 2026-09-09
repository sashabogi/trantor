#!/usr/bin/env node
// #6888 / npm v12: the per-project Graft index build (bin/crew/open.mjs maybeBuildGraft).
//
// The bug this locks down: the build is spawned detached, and it used to run with stdio:"ignore", so
// a graft that cannot parse — the npm v12 case, where lifecycle scripts and implicit node-gyp builds
// are off and tree-sitter's native bindings were never built — failed in complete silence while the
// pane printed "indexing this project…". A green message over a dead tool.
//
// Everything here runs against a FAKE graft on PATH in a temp dir. No real graft, no real project.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};

const scratch = mkdtempSync(join(tmpdir(), "graft-index-test-"));
const cleanup = [scratch];

/** A project dir with one source file and no graft index. */
function project(name) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a.mjs"), "export const a = 1;\n");
  return dir;
}

/** A fake `graft` on PATH. `body` is the shell script after the shebang. */
function fakeGraft(name, body) {
  const bin = join(scratch, `bin-${name}`);
  mkdirSync(bin, { recursive: true });
  const p = join(bin, "graft");
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return bin;
}

/**
 * Run maybeBuildGraft(dir) in a child node process with `bin` prepended to PATH, and wait for the
 * detached grandchild to finish. The function unrefs, so the parent exits first by design — the test
 * polls the log the way an operator would look at it afterwards.
 */
function runOpen(dir, bin) {
  const script = `
    import { maybeBuildGraft } from ${JSON.stringify(join(ROOT, "bin/crew/open.mjs"))};
    maybeBuildGraft(${JSON.stringify(dir)});
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, PATH: bin ? `${bin}:${process.env.PATH}` : "/usr/bin:/bin" },
  });
  return { stderr: r.stderr || "", status: r.status };
}

const logFor = (dir) => join(tmpdir(), `trantor-graft-build-${basename(dir)}.log`);

/** The grandchild is detached; give it a moment to write and exit. */
function waitForLog(path, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, "utf8").length) return readFileSync(path, "utf8");
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{},80)"]);   // ~80ms, dependency-free
  }
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

console.log("\nno graft on PATH — a clean no-op, not a crash");
{
  const dir = project("no-graft");
  const { stderr, status } = runOpen(dir, "");
  ok("exits 0", status === 0, `status=${status}`);
  ok("says nothing about indexing", !/indexing this project/.test(stderr));
  ok("writes no .gitignore", !existsSync(join(dir, ".gitignore")));
}

console.log("\nan index already exists — no second build");
{
  const dir = project("already-indexed");
  mkdirSync(join(dir, "graft"), { recursive: true });
  writeFileSync(join(dir, "graft", ".graph"), "{}");
  const bin = fakeGraft("marker", `touch "${join(scratch, "SHOULD-NOT-EXIST")}"; exit 0`);
  const { stderr } = runOpen(dir, bin);
  ok("does not spawn a build", !existsSync(join(scratch, "SHOULD-NOT-EXIST")));
  ok("and says nothing", !/indexing this project/.test(stderr));
}

console.log("\na healthy graft — builds, gitignores, announces");
{
  const dir = project("healthy");
  rmSync(logFor(dir), { force: true });
  const bin = fakeGraft("healthy", 'exit 0');
  const { stderr } = runOpen(dir, bin);
  ok("announces the background build", /indexing this project/.test(stderr));
  ok("names the log path so a failure is findable", stderr.includes(logFor(dir)), stderr.trim());
  ok("adds graft/ to .gitignore", /^graft\/$/m.test(readFileSync(join(dir, ".gitignore"), "utf8")));
}

console.log("\nTHE CASE THAT MATTERS: graft is on PATH but cannot parse");
{
  const dir = project("broken");
  const log = logFor(dir);
  rmSync(log, { force: true });
  // What an unbuilt native binding actually looks like from the outside.
  const bin = fakeGraft("broken", 'echo "Error: Cannot find module \'tree-sitter\'" >&2; exit 1');
  runOpen(dir, bin);
  const body = waitForLog(log);
  ok("the failure is written down instead of vanishing", body.length > 0, `log=${log}`);
  ok("and it carries the real reason", /tree-sitter/.test(body), JSON.stringify(body.slice(0, 120)));
  ok("no index was produced", !existsSync(join(dir, "graft", ".graph")));
  rmSync(log, { force: true });
}

for (const d of cleanup) rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

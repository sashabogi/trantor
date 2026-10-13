import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkMemory, formatMemoryCheck, memoryDirectory, notePins } from "../../lib/memory-pins.mjs";
import { pinMemory } from "../../lib/memory-pin-write.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const out = join(root, ".agent-bus-out");
mkdirSync(out, { recursive: true });

function fixture(t, build = true) {
  const dir = mkdtempSync(join(out, "memory-hook-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, "project");
  const config = join(dir, "claude");
  const memoryDir = memoryDirectory(project, config);
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  assert.equal(spawnSync("git", ["init", project]).status, 0);
  const source = join(project, "src/code.mjs");
  writeFileSync(source, "export function advise() { return 1; }\n");
  if (build) {
    const result = spawnSync("graft", ["build", project, "--no-gitignore", "--no-ignore"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const rawHook = (input, env = {}) => spawnSync(process.execPath, [join(root, "hooks/memory-pin.mjs")], {
    cwd: root, encoding: "utf8", input,
    env: { ...process.env, CLAUDE_CONFIG_DIR: config, ...env }, timeout: 10000,
  });
  const hook = (input, env) => rawHook(JSON.stringify(input), env);
  const event = (path, tool_name = "Write", cwd = project) => ({ tool_name, cwd, tool_input: { file_path: path } });
  return { dir, project, memoryDir, source, hook, rawHook, event };
}

function silentSuccess(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
}

test("Write pins a symbol; Edit refreshes a stale note and memory check goes quiet", t => {
  const f = fixture(t);
  const path = join(f.memoryDir, "advice.md");
  const body = "---\nname: Advice\n---\nSee src/code.mjs#advise.\n";
  writeFileSync(path, body);
  const write = f.hook(f.event(path));
  silentSuccess(write);
  assert.equal(write.stderr, "");
  const first = notePins(readFileSync(path, "utf8"))[0];
  assert.equal(first.symbol, "src/code.mjs#advise");
  assert.match(first.fp, /^sha256:[a-f0-9]{16}$/);
  writeFileSync(f.source, "export function advise() { return 2; }\n");
  assert.match(formatMemoryCheck(checkMemory(f)), /stale/);
  writeFileSync(path, readFileSync(path, "utf8") + "Still accurate.\n");
  silentSuccess(f.hook(f.event(path, "Edit", join(f.project, "src"))));
  assert.notEqual(notePins(readFileSync(path, "utf8"))[0].fp, first.fp);
  assert.equal(formatMemoryCheck(checkMemory(f)), "ok: 1 notes, 1 pins");
  assert.ok(readFileSync(path, "utf8").endsWith("See src/code.mjs#advise.\nStill accurate.\n"));
});

test("hook excludes index, non-Markdown, nested, foreign-project and non-memory files", t => {
  const f = fixture(t);
  const paths = [join(f.memoryDir, "MEMORY.md"), join(f.memoryDir, "note.txt"),
    join(f.memoryDir, "nested/note.md"), join(f.project, "note.md"),
    join(f.dir, "claude/projects/other/memory/note.md")];
  for (const path of paths) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "src/code.mjs#advise\n");
    silentSuccess(f.hook(f.event(path)));
    assert.equal(readFileSync(path, "utf8"), "src/code.mjs#advise\n");
  }
  const valid = join(f.memoryDir, "valid.md");
  writeFileSync(valid, "src/code.mjs#advise\n");
  silentSuccess(f.hook(f.event(valid, "Read")));
  assert.equal(notePins(readFileSync(valid, "utf8")).length, 0);
  const link = join(f.memoryDir, "link.md");
  symlinkSync(join(f.project, "note.md"), link);
  silentSuccess(f.hook(f.event(link)));
  assert.equal(notePins(readFileSync(link, "utf8")).length, 0);
});

test("missing graph, invalid input, malformed note and graft failure log without tool errors", t => {
  const f = fixture(t, false);
  const path = join(f.memoryDir, "note.md");
  writeFileSync(path, "src/code.mjs#advise\n");
  const off = f.hook(f.event(path));
  silentSuccess(off);
  assert.match(off.stderr, /no graft graph, pins off/);
  const invalid = f.rawHook("{");
  silentSuccess(invalid);
  assert.match(invalid.stderr, /memory-pin:/);
  mkdirSync(join(f.project, "graft/.graph"), { recursive: true });
  writeFileSync(join(f.project, "graft/.graph/wiring.json"), '{"nodes":[]}');
  utimesSync(join(f.project, "graft/.graph/wiring.json"), new Date(0), new Date(0));
  const failure = f.hook(f.event(path), { PATH: f.dir });
  silentSuccess(failure);
  assert.match(failure.stderr, /graft build failed/);
  assert.equal(readFileSync(path, "utf8"), "src/code.mjs#advise\n");
  const malformed = "---\npins: [\n---\nsrc/code.mjs#advise\n";
  writeFileSync(path, malformed);
  const bad = f.hook(f.event(path));
  silentSuccess(bad);
  assert.match(bad.stderr, /invalid front matter/);
  assert.equal(readFileSync(path, "utf8"), malformed);
});

test("informational candidates omit sibling notes and bare versions but retain paths and source extensions", t => {
  const f = fixture(t);
  writeFileSync(join(f.memoryDir, "trantor-gotchas.md"), "Sibling note\n");
  writeFileSync(join(f.memoryDir, "note.md"), "trantor-gotchas.md [[another.md]] 0.18.16 2.2x 99.5 turns/22.9h 2.rs missing.mjs other.md src/code.mjs#advise");
  const result = pinMemory({ ...f, note: "note.md", dryRun: true }).notes[0];
  assert.deepEqual(result.diagnostics, ["turns/22.9h", "2.rs", "missing.mjs", "other.md"]
    .map(path => `mentions a path that doesn't exist: ${path}`));
  assert.deepEqual(result.pins.map(pin => pin.symbol), ["src/code.mjs#advise"]);
});

test("PostToolUse registration is asynchronous and limited to Write/Edit", () => {
  const config = JSON.parse(readFileSync(join(root, "hooks/hooks.json"), "utf8"));
  const entry = config.hooks.PostToolUse.find(entry => entry.hooks.some(hook => hook.command.endsWith("/memory-pin.mjs")));
  assert.equal(entry.matcher, "Write|Edit");
  assert.equal(entry.hooks[0].async, true);
});

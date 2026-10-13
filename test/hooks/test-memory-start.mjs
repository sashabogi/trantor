import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { fingerprint, memoryDirectory } from "../../lib/memory-pins.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const out = join(root, ".agent-bus-out");
mkdirSync(out, { recursive: true });
const source = "export function advice() { return 1; }\n";

function fixture(t) {
  const dir = mkdtempSync(join(out, "memory-start-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, "project");
  const config = join(dir, "claude");
  const memoryDir = memoryDirectory(project, config);
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(project, "graft/.graph"), { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(join(dir, "home"));
  assert.equal(spawnSync("git", ["init", project]).status, 0);
  writeFileSync(join(project, "src/code.mjs"), source);
  const graph = join(project, "graft/.graph/wiring.json");
  writeFileSync(graph, JSON.stringify({ nodes: [{ id: "src/code.mjs#advice", path: "src/code.mjs", kind: "function", span: "L1-L1" }] }));
  const note = (name, pins) => writeFileSync(join(memoryDir, name), `---\npins: ${JSON.stringify(pins)}\n---\nA note.\n`);
  const pin = { symbol: "src/code.mjs#advice", fp: fingerprint(source) };
  const run = (preload, cwd = project) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(RELAY_|TRANTOR_|HERDR_|CREW_|RUNNER_|CLAUDE_|AGENT_BUS_)/.test(key)));
    const result = spawnSync(process.execPath, [...(preload ? ["--import", preload] : []), join(root, "hooks/sessionstart.mjs")], {
      cwd: root, encoding: "utf8", timeout: 10000,
      input: JSON.stringify({ cwd, source: "startup" }),
      env: { ...env, HOME: join(dir, "home"), AGENT_BUS_DIR: join(dir, "bus"), CLAUDE_CONFIG_DIR: config,
        RELAY_URL: "http://127.0.0.1:1", RELAY_SESSION: "memory-drill:fixture", RELAY_PROJECT: "fixture",
        TRANTOR_NO_UPDATE_CHECK: "1", TRANTOR_NO_BALANCE_CHECK: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).hookSpecificOutput?.additionalContext || "";
  };
  return { dir, project, memoryDir, graph, note, pin, run };
}

function memoryLines(context) {
  return context.split("\n").filter(line => /(?:stale, \d+ broken notes:|pinned notes unchecked|pin check skipped)/.test(line));
}

test("session-start first context line counts notes, reads disk bodies and never rebuilds graft", t => {
  const f = fixture(t);
  f.note("stale.md", [f.pin, f.pin]);
  f.note("both.md", [f.pin, { file: "missing.mjs" }]);
  f.note("broken.md", [{ symbol: "src/code.mjs#gone", fp: f.pin.fp }]);
  writeFileSync(join(f.project, "src/code.mjs"), source.replace("return 1", "return 9"));
  utimesSync(f.graph, new Date(), new Date(Date.now() + 1000));
  const graphBefore = readFileSync(f.graph, "utf8");
  const guard = join(f.dir, "forbid-spawn.mjs");
  writeFileSync(guard, 'import cp from "node:child_process"; import { syncBuiltinESMExports } from "node:module"; cp.spawnSync = () => { throw new Error("graph rebuild forbidden"); }; syncBuiltinESMExports();');
  const context = f.run(guard, join(f.project, "src"));
  const expected = "2 stale, 2 broken notes: both.md, broken.md, stale.md; run trantor memory check";
  assert.equal(context.split("\n")[0], expected);
  assert.deepEqual(memoryLines(context), [expected]);
  assert.equal(readFileSync(f.graph, "utf8"), graphBefore);
});

test("fresh pins, unpinned notes and MEMORY.md produce no memory context", t => {
  const f = fixture(t);
  f.note("fresh.md", [f.pin]);
  f.note("MEMORY.md", [{ file: "missing.mjs" }]);
  writeFileSync(join(f.memoryDir, "unpinned.md"), "src/code.mjs#advice\n");
  assert.deepEqual(memoryLines(f.run()), []);
});

test("deleted files are broken; a changed bare file never becomes stale", t => {
  const f = fixture(t);
  f.note("bare.md", [{ file: "src/code.mjs" }]);
  writeFileSync(join(f.project, "src/code.mjs"), "Changed entirely\n");
  assert.equal(memoryLines(f.run())[0], "1 pinned notes unchecked (graph older than code), run trantor memory check");
  rmSync(join(f.project, "src/code.mjs"));
  assert.deepEqual(memoryLines(f.run()), ["0 stale, 1 broken notes: bare.md; run trantor memory check"]);
});

test("missing or corrupt graph and malformed notes never fail session start", t => {
  const f = fixture(t);
  f.note("broken.md", [{ file: "missing.mjs" }]);
  rmSync(f.graph);
  assert.deepEqual(memoryLines(f.run()), []);
  writeFileSync(f.graph, "{");
  assert.deepEqual(memoryLines(f.run()), []);
  writeFileSync(f.graph, '{"nodes":[]}');
  writeFileSync(join(f.memoryDir, "invalid.md"), "---\npins: [\n---\n");
  assert.deepEqual(memoryLines(f.run()), ["0 stale, 1 broken notes: broken.md; run trantor memory check"]);
});

test("a slow worker is stopped at the budget and session start emits just the skip line", t => {
  const f = fixture(t);
  f.note("broken.md", [{ file: "missing.mjs" }]);
  const slow = join(f.dir, "slow-worker.mjs");
  writeFileSync(slow, 'import { isMainThread } from "node:worker_threads"; if (!isMainThread) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);');
  const start = performance.now();
  const context = f.run(slow);
  assert.ok(performance.now() - start < 3000, "session did not wait for the five-second worker");
  assert.deepEqual(memoryLines(context), ["pin check skipped (slow), run trantor memory check"]);
});

test("note names with newlines still occupy one context line", t => {
  const f = fixture(t);
  f.note("odd\nname.md", [{ file: "missing.mjs" }]);
  assert.deepEqual(memoryLines(f.run()), ["0 stale, 1 broken notes: odd name.md; run trantor memory check"]);
});

test("newer source with shifted spans counts unchecked notes without an empty stale prefix", t => {
  const f = fixture(t);
  f.note("shifted.md", [f.pin, f.pin]);
  f.note("other.md", [f.pin]);
  writeFileSync(join(f.project, "src/code.mjs"), `// inserted\n\n${source}`);
  utimesSync(join(f.project, "src/code.mjs"), new Date(), new Date(Date.now() + 1000));
  const line = memoryLines(f.run())[0];
  assert.equal(line, "2 pinned notes unchecked (graph older than code), run trantor memory check");
});

test("broken and unchecked notes share one memory check instruction", t => {
  const f = fixture(t);
  f.note("mixed.md", [f.pin, { file: "missing.mjs" }]);
  utimesSync(join(f.project, "src/code.mjs"), new Date(), new Date(Date.now() + 1000));
  assert.equal(memoryLines(f.run())[0], "0 stale, 1 broken notes: mixed.md; 1 pinned notes unchecked (graph older than code), run trantor memory check");
});

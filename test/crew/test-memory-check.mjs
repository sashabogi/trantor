import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkMemory, fingerprint, formatMemoryCheck, memoryDirectory, notePins, pinTarget } from "../../lib/memory-pins.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const out = join(root, ".agent-bus-out");
mkdirSync(out, { recursive: true });
const body = "export function advise() {\n  return 1;\n}";

function fixture(t) {
  const dir = mkdtempSync(join(out, "memory-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, "project");
  const config = join(dir, "claude");
  const memoryDir = memoryDirectory(project, config);
  mkdirSync(project, { recursive: true });
  assert.equal(spawnSync("git", ["init", project], { encoding: "utf8" }).status, 0);
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(project, "sample.mjs"), `${body}\nexport const other = 1;\n`);
  const note = `---\nname: advice\ndescription: preserve me\nmetadata:\n  kind: project\npins:\n  - symbol: sample.mjs#advise\n    fp: ${fingerprint(body)}\n    at: 2026-10-12\n    future: kept\n  - file: sample.mjs\n---\nUnchanged note text.\n`;
  writeFileSync(join(memoryDir, "advice.md"), note);
  const run = () => checkMemory({ project, memoryDir });
  const build = () => {
    const result = spawnSync("graft", ["build", project, "--no-gitignore", "--no-ignore"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  };
  const cli = (...args) => spawnSync(process.execPath, [join(root, "bin/cli.mjs"), "memory", "check", "--project", project, ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: config },
  });
  return { project, memoryDir, note, run, build, cli };
}

test("no graph is explicit and does not create one", t => {
  const f = fixture(t);
  assert.equal(f.run().message, "no graft graph, pins off");
  assert.equal(f.cli().stdout.trim(), "no graft graph, pins off");
});

test("unchanged pins stay quiet, JSON includes results and note bytes survive", t => {
  const f = fixture(t);
  f.build();
  assert.equal(f.cli().stdout.trim(), "ok: 1 notes, 2 pins");
  const json = f.cli("--json");
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).notes[0].pins.map(p => p.status), ["ok", "ok"]);
  assert.equal(readFileSync(join(f.memoryDir, "advice.md"), "utf8"), f.note);
});

test("working tree edits go stale and deleted files go broken", t => {
  const f = fixture(t);
  f.build();
  writeFileSync(join(f.project, "sample.mjs"), `${body.replace("return 1", "return 2")}\n`);
  const changed = f.run();
  assert.deepEqual(changed.notes[0].pins.map(p => p.status), ["stale", "ok"]);
  assert.match(formatMemoryCheck(changed), /advice.md: stale.*sample.mjs#advise.*body|advice.md: stale.*body changed: sample.mjs#advise/);
  rmSync(join(f.project, "sample.mjs"));
  assert.deepEqual(f.run().notes[0].pins.map(p => p.status), ["broken", "broken"]);
});

test("unrelated edits, moved spans and normalized whitespace stay quiet", t => {
  const f = fixture(t);
  f.build();
  writeFileSync(join(f.project, "sample.mjs"), `// moved\n\n${body}\nexport const other = 42;\n`.replace(/\n/g, "  \r\n"));
  assert.match(formatMemoryCheck(f.run()), /^ok: 1 notes, [12] pins$/);
  assert.equal(fingerprint(`\n  \n${body} \r\n\n`), fingerprint(body));
});

test("renamed symbol is broken even with an old graph", t => {
  const f = fixture(t);
  f.build();
  writeFileSync(join(f.project, "sample.mjs"), body.replace("advise", "renamed"));
  const result = f.run().notes[0].pins;
  assert.deepEqual(result.map(p => p.status), ["broken", "ok"]);
  assert.match(result[0].detail, /symbol gone/);
});

test("malformed pins are reported and unknown keys remain intact", t => {
  const f = fixture(t);
  f.build();
  const pins = [null, "bad", { symbol: "sample.mjs#advise" }, { file: "../outside" }, { file: "sample.mjs", fp: "bad" }, { symbol: "sample.mjs#advise", file: "sample.mjs", fp: fingerprint(body) }];
  writeFileSync(join(f.memoryDir, "bad.md"), `---\npins: ${JSON.stringify(pins)}\n---\n`);
  writeFileSync(join(f.memoryDir, "syntax.md"), "---\npins: [\n---\n");
  const result = f.run();
  assert.equal(result.notes.find(n => n.name === "bad.md").pins.length, 6);
  assert.ok(result.notes.find(n => n.name === "bad.md").pins.every(p => p.status === "invalid pin"));
  assert.equal(result.notes.find(n => n.name === "syntax.md").pins[0].status, "invalid pin");
  assert.equal(result.notes.find(n => n.name === "advice.md").pins[0].pin.future, "kept");
  assert.deepEqual(notePins("---\nname: unpinned\n---\n"), []);
});

test("nested symbol IDs resolve without confusing same-named methods", t => {
  const f = fixture(t);
  const source = "export class A {\n  act() { return 1; }\n}\nexport class B {\n  act() { return 2; }\n}\n";
  writeFileSync(join(f.project, "sample.mjs"), source);
  f.build();
  const graph = JSON.parse(readFileSync(join(f.project, "graft/.graph/wiring.json"), "utf8"));
  assert.ok(graph.nodes.some(n => n.id === "sample.mjs#A.act"));
  writeFileSync(join(f.memoryDir, "advice.md"), `---\npins:\n  - symbol: sample.mjs#A.act\n    fp: ${fingerprint("  act() { return 1; }")}\n---\n`);
  assert.match(formatMemoryCheck(f.run()), /^ok: 1 notes, [12] pins$/);
  writeFileSync(join(f.project, "sample.mjs"), source.replace("return 2", "return 3"));
  assert.match(formatMemoryCheck(f.run()), /^ok: 1 notes, [12] pins$/);
  assert.equal(memoryDirectory(f.project, join(out, "config")), join(out, "config", "projects", resolve(f.project).replace(/[^a-zA-Z0-9]/g, "-"), "memory"));
});

test("bad spans isolate each pin and clean CLI has strict opt-in", t => {
  const f = fixture(t);
  f.build();
  const graphPath = join(f.project, "graft/.graph/wiring.json");
  const graph = JSON.parse(readFileSync(graphPath, "utf8"));
  graph.nodes.find(node => node.id === "sample.mjs#advise").span = "L999-L1000";
  writeFileSync(graphPath, JSON.stringify(graph));
  writeFileSync(join(f.memoryDir, "other.md"), '---\npins: [{file: missing.mjs}]\n---\n');
  const result = f.run();
  assert.deepEqual(result.notes[0].pins.map(pin => pin.status), ["invalid pin", "ok"]);
  assert.equal(result.notes[1].pins[0].status, "broken");
  assert.doesNotMatch(formatMemoryCheck(result), /invalid pin.*invalid pin/);
  assert.equal(f.cli().status, 0);
  assert.equal(f.cli("--strict").status, 1);
  assert.deepEqual(pinTarget({ symbol: "dir/hash#file.mjs#fn", fp: fingerprint(body) }), {
    file: "dir/hash#file.mjs", symbol: "dir/hash#file.mjs#fn",
  });
});

test("failed refresh reports pins off with the reason and releases lock", t => {
  const f = fixture(t);
  f.build();
  const graphPath = join(f.project, "graft/.graph/wiring.json");
  utimesSync(graphPath, new Date(0), new Date(0));
  const previous = process.env.PATH;
  process.env.PATH = out;
  try {
    const result = f.run();
    assert.equal(result.status, "pins off");
    assert.match(result.message, /graft build failed/);
  } finally { process.env.PATH = previous; }
  assert.equal(f.run().status, "checked");
});

test("concurrent checks serialize refresh and reuse the graph built by the winner", async t => {
  const f = fixture(t);
  f.build();
  const graph = join(f.project, "graft/.graph/wiring.json");
  utimesSync(graph, new Date(0), new Date(0));
  const commands = join(f.project, "commands");
  mkdirSync(commands);
  const calls = join(commands, "builds");
  writeFileSync(join(commands, "graft"), `#!${process.execPath}
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(calls)}, "build\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
fs.utimesSync(${JSON.stringify(graph)}, new Date(), new Date());
`, { mode: 0o755 });
  const script = `import { checkMemory } from ${JSON.stringify(new URL("../../lib/memory-pins.mjs", import.meta.url).href)};
console.log(JSON.stringify(checkMemory(${JSON.stringify({ project: f.project, memoryDir: f.memoryDir })})));`;
  const run = () => new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root, env: { ...process.env, PATH: commands },
    });
    let output = "", errors = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { errors += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) return reject(new Error(errors));
      try { resolveRun(JSON.parse(output)); } catch (error) { reject(error); }
    });
  });
  const results = await Promise.all([run(), run()]);
  assert.ok(results.every(result => result.status === "checked"), JSON.stringify(results));
  assert.equal(readFileSync(calls, "utf8"), "build\n");
  assert.equal(existsSync(`${graph}.lock`), false);
});

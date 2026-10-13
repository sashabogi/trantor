import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkMemory, memoryDirectory, notePins } from "../../lib/memory-pins.mjs";
import { extractMentions, pinMemory, replaceNotePins } from "../../lib/memory-pin-write.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const out = join(root, ".agent-bus-out");
mkdirSync(out, { recursive: true });
const source = "export function advise() {\n  return 1;\n}\nexport class Crew {\n  run() { return 2; }\n}\n";
function fixture(t, build = true) {
  const dir = mkdtempSync(join(out, "memory-pin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, "project");
  const config = join(dir, "claude");
  const memoryDir = memoryDirectory(project, config);
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  assert.equal(spawnSync("git", ["init", project]).status, 0);
  writeFileSync(join(project, "src/code.mjs"), source);
  writeFileSync(join(project, "README.md"), "A project\n");
  if (build) {
    const result = spawnSync("graft", ["build", project, "--no-gitignore", "--no-ignore"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  }
  return {
    project, memoryDir,
    write: (name, text) => writeFileSync(join(memoryDir, name), text),
    read: name => readFileSync(join(memoryDir, name), "utf8"),
    pin: options => pinMemory({ project, memoryDir, ...options }),
    check: () => checkMemory({ project, memoryDir }),
    cli: (...args) => spawnSync(process.execPath, [join(root, "bin/cli.mjs"), "memory", ...args, "--project", project], {
      cwd: root, encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: config },
    }),
  };
}

test("dry-run lists symbol, enclosing method and bare file without writing; apply checks quiet", t => {
  const f = fixture(t);
  const text = "---\nname: 'Advice' # keep\nmetadata:\n  order: [b, a]\ndescription: >\n  folded description\n---\n`src/code.mjs#advise`, src/code.mjs:5 and README.md.\n[[src/code.mjs#Crew]]\n";
  f.write("advice.md", text);
  f.write("empty.md", "Nothing to pin.\n");
  const dry = f.cli("pin", "--all", "--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /src\/code.mjs#advise/);
  assert.match(dry.stdout, /src\/code.mjs#Crew.run/);
  assert.match(dry.stdout, /README.md/);
  assert.equal(f.read("advice.md"), text);
  const apply = f.cli("pin", "--all", "--json");
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(JSON.parse(apply.stdout).notes.length, 2);
  const pins = notePins(f.read("advice.md"));
  assert.deepEqual(pins.map(p => p.symbol || p.file), ["src/code.mjs#advise", "src/code.mjs#Crew.run", "README.md"]);
  assert.ok(pins.slice(0, 2).every(p => /^sha256:[a-f0-9]{16}$/.test(p.fp)));
  assert.equal(pins[2].fp, undefined);
  assert.equal(f.read("advice.md").replace(/^pins:.*\n/m, ""), text);
  assert.equal(f.read("empty.md"), "Nothing to pin.\n");
  assert.ok(f.check().notes.flatMap(n => n.pins).every(p => p.status === "ok"));
});

test("re-pin clears stale bodies, keeps manual pins and unknown fields, and is idempotent", t => {
  const f = fixture(t);
  f.write("manual.md", "---\nname: manual\npins:\n  - symbol: src/code.mjs#advise\n    fp: sha256:0000000000000000\n    future: {keep: true}\n  - file: README.md\n    owner: someone\n---\nNo mentions.\n");
  assert.equal(f.check().notes[0].pins[0].status, "stale");
  f.pin({ note: "manual" });
  assert.deepEqual(f.check().notes[0].pins.map(p => p.status), ["ok", "ok"]);
  const pins = notePins(f.read("manual.md"));
  assert.deepEqual(pins[0].future, { keep: true });
  assert.equal(pins[1].owner, "someone");
  const first = f.read("manual.md");
  f.pin({ note: join(f.memoryDir, "manual.md") });
  assert.equal(f.read("manual.md"), first);
  writeFileSync(join(f.project, "src/code.mjs"), source.replace("return 1", "return 7"));
  assert.equal(f.check().notes[0].pins[0].status, "stale");
  f.pin({ note: "manual" });
  assert.equal(f.check().notes[0].pins[0].status, "ok");
});

test("value splicing preserves CRLF, comments, other keys, body and key order", () => {
  const pins = [{ file: "README.md", future: [1, 2] }];
  for (const newline of ["\n", "\r\n"]) {
    const before = ["---", "# intro", "name: 'Hello'", "pins:", "  "].join(newline);
    const after = ["# description comment", "description: |", "  exact text", "metadata: { z: 1, a: 2 }", "---", "body\t ", ""].join(newline);
    const text = before + "- file: old.md" + newline + after;
    const changed = replaceNotePins(text, pins);
    assert.ok(changed.startsWith(before));
    assert.ok(changed.endsWith(newline + after));
    assert.deepEqual(notePins(changed), pins);
  }
  const inline = '---\nname: x\npins: [] # pin comment\ndescription: y\n---\nbody';
  assert.match(replaceNotePins(inline, pins), / # pin comment\ndescription: y\n---\nbody$/);
  assert.deepEqual(notePins(replaceNotePins('---\npins:\nname: x\n---\n', pins)), pins);
});

test("body-only note gets front matter; links and URLs do not add pins", t => {
  const f = fixture(t);
  const text = "See `src/code.mjs#advise` twice: src/code.mjs#advise. [[src/code.mjs]] https://example.com/src/code.mjs and/or\n";
  f.write("body.md", text);
  f.pin({ note: "body" });
  assert.ok(f.read("body.md").endsWith(text));
  assert.equal(notePins(f.read("body.md")).length, 1);
  const graph = JSON.parse(readFileSync(join(f.project, "graft/.graph/wiring.json"), "utf8"));
  assert.equal(extractMentions("[[README.md]] https://x/README.md and/or", f.project, new Map(graph.nodes.map(n => [n.id, n]))).length, 0);
});

test("broken and malformed manual entries survive, unresolved mentions are not downgraded", t => {
  const f = fixture(t);
  f.write("broken.md", "---\npins:\n  - file: absent.md\n    custom: kept\n  - symbol: src/code.mjs#gone\n    fp: sha256:0000000000000000\n  - nonsense\n---\nsrc/code.mjs#missing src/code.mjs:99 src/code.mjs:0\n");
  const original = notePins(f.read("broken.md"));
  const result = f.pin({ note: "broken" }).notes[0];
  assert.deepEqual(notePins(f.read("broken.md")), original);
  assert.equal(result.diagnostics.filter(d => d.startsWith("unresolved mention")).length, 3);
  assert.ok(result.diagnostics.some(d => d.startsWith("invalid pin")));
  assert.ok(result.diagnostics.some(d => d.startsWith("broken")));
});

test("invalid YAML is diagnosed without rewriting and other notes still pin", t => {
  const f = fixture(t);
  const invalid = "---\nname: x\npins: [\n---\nsrc/code.mjs\n";
  f.write("invalid.md", invalid);
  f.write("good.md", "README.md\n");
  const result = f.pin({ all: true });
  assert.equal(f.read("invalid.md"), invalid);
  assert.match(result.notes.find(n => n.name === "invalid.md").diagnostics[0], /invalid front matter/);
  assert.equal(notePins(f.read("good.md"))[0].file, "README.md");
});

test("no graph leaves notes untouched, and CLI rejects ambiguous or outside note selection", t => {
  const f = fixture(t, false);
  f.write("note.md", "README.md\n");
  assert.equal(f.pin({ all: true }).message, "no graft graph, pins off");
  assert.equal(f.read("note.md"), "README.md\n");
  for (const args of [["pin"], ["pin", "note", "--all"], ["pin", "../note"], ["pin", "missing"], ["check", "--all"]]) {
    const result = f.cli(...args);
    assert.equal(result.status, 1, result.stdout + result.stderr);
  }
});


test("real-note candidates stay informational unless the file exists", t => {
  const f = fixture(t);
  const missing = [
    "0.18.83/0.18.84", "2.0/6.0", "0.17.56/.57", "zai-coding-plan/glm-5.1",
    "gui/501/com.trantor.duty", "registry.json/capabilities.json",
    "overseer.mjs/routes/admin.mjs/package.json", "proposal.filed/.decided/.withdrawn",
    "README/package.json", "PRD/TDD/CHECKLIST-reassembly.md", "token-scrooge/.env",
    "bin/crew.sh", "lib/wake.mjs", "bin/audit.mjs", "missing.mjs",
  ];
  writeFileSync(join(f.project, "package.json"), "{}\n");
  f.write("mentions.md", missing.map(path => `\`${path}\``).join("\n"));
  const original = f.read("mentions.md");
  const dry = f.cli("pin", "--all", "--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(f.read("mentions.md"), original);
  for (const path of missing) assert.ok(dry.stdout.includes(`mentions a path that doesn't exist: ${path}`), path);
  assert.ok(!dry.stdout.includes("broken:"));
  const result = f.pin({ all: true }).notes[0];
  assert.deepEqual(result.pins, []);
  assert.deepEqual(result.diagnostics, missing.map(path => `mentions a path that doesn't exist: ${path}`));
  assert.equal(f.read("mentions.md"), original);
  assert.deepEqual(f.check().notes[0].pins, []);
});

test("repo prefix resolves files and symbols, and top-level file:line falls back to a file pin", t => {
  const f = fixture(t);
  mkdirSync(join(f.project, "engine"));
  writeFileSync(join(f.project, "engine/README.md"), "Engine\n");
  writeFileSync(join(f.project, "hub.mjs"), "// top-level\n".repeat(15) + "console.log('ready');\n");
  const prefix = basename(f.project);
  f.write("prefix.md", `${prefix}/engine/README.md ${prefix}/src/code.mjs#advise ${prefix}/src/code.mjs:2 hub.mjs:16`);
  const result = f.pin({ all: true }).notes[0];
  assert.deepEqual(result.pins.map(p => p.symbol || p.file), ["engine/README.md", "src/code.mjs#advise", "hub.mjs"]);
  assert.deepEqual(result.diagnostics, []);
  assert.ok(f.check().notes[0].pins.every(pin => pin.status === "ok"));
  const nodes = new Map();
  assert.deepEqual(extractMentions("trantor/engine/README.md", f.project, nodes), [{ file: "trantor/engine/README.md" }]);
  const trantor = join(f.project, "trantor");
  mkdirSync(join(trantor, "engine"), { recursive: true });
  writeFileSync(join(trantor, "engine/README.md"), "Engine\n");
  assert.deepEqual(extractMentions("trantor/engine/README.md", trantor, nodes), [{ file: "engine/README.md" }]);
  mkdirSync(join(trantor, "trantor/engine"), { recursive: true });
  writeFileSync(join(trantor, "trantor/engine/README.md"), "Nested engine\n");
  assert.deepEqual(extractMentions("trantor/engine/README.md", trantor, nodes), [{ file: "trantor/engine/README.md" }]);
});

test("a file becomes broken only after a pinned file is deleted", t => {
  const f = fixture(t);
  f.write("deleted.md", "README.md src/code.mjs#missing");
  const pinned = f.pin({ all: true }).notes[0];
  assert.deepEqual(pinned.pins.map(pin => pin.file), ["README.md"]);
  assert.deepEqual(pinned.diagnostics, ["unresolved mention: src/code.mjs#missing"]);
  rmSync(join(f.project, "README.md"));
  const checked = f.check().notes[0].pins;
  assert.equal(checked[0].status, "broken");
  const repinned = f.pin({ all: true }).notes[0];
  assert.deepEqual(repinned.pins, pinned.pins);
  assert.ok(repinned.diagnostics.includes("broken: file gone: README.md"));
  assert.ok(repinned.diagnostics.includes("mentions a path that doesn't exist: README.md"));
});

#!/usr/bin/env node
// Link the plugin's module graphs without running hook bodies (which can exit, spawn or register).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as vm from "node:vm";

if (!vm.SourceTextModule) {
  const run = spawnSync(process.execPath, ["--experimental-vm-modules", fileURLToPath(import.meta.url)], {
    stdio: "inherit", timeout: 30000,
  });
  process.exit(run.status ?? 1);
}

const root = fileURLToPath(new URL("../..", import.meta.url));
const work = mkdtempSync(join(realpathSync("/tmp"), "trantor-hook-snapshot-"));
const snapshot = join(work, "plugin");
const require = createRequire(import.meta.url);

function modules(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? modules(path) : entry.name.endsWith(".mjs") ? [path] : [];
  });
}

async function linkSnapshot() {
  const cache = new Map();
  function load(specifier, parent) {
    if (isBuiltin(specifier)) {
      if (!cache.has(specifier)) cache.set(specifier, new vm.SyntheticModule(Object.keys(require(specifier)), () => {}));
      return cache.get(specifier);
    }
    // Never consult node_modules, NODE_PATH or the global trantor install. Only dep() may
    // resolve packages at runtime; its dynamic import is deliberately not evaluated here.
    if (!specifier.startsWith(".") && !specifier.startsWith("file:")) {
      throw new Error(`${relative(snapshot, fileURLToPath(parent))}: unresolved package '${specifier}' (use lib/dep.mjs)`);
    }
    const url = new URL(specifier, parent).href;
    if (!cache.has(url)) {
      cache.set(url, new vm.SourceTextModule(readFileSync(new URL(url), "utf8"), { identifier: url }));
    }
    return cache.get(url);
  }
  const entries = [...modules(join(snapshot, "hooks")), join(snapshot, "mcp.mjs")];
  const entry = new vm.SourceTextModule(entries.map(path => `import ${JSON.stringify(pathToFileURL(path).href)};`).join("\n"), {
    identifier: pathToFileURL(join(snapshot, "probe.mjs")).href,
  });
  await entry.link((specifier, parent) => load(specifier, parent.identifier));
  return entries.length;
}

try {
  // bin/ contains real transitive imports of hooks/lib and mcp.mjs.
  for (const name of ["hooks", "lib", "bin", "mcp.mjs"]) cpSync(join(root, name), join(snapshot, name), { recursive: true });
  writeFileSync(join(snapshot, "package.json"), '{"type":"module"}');
  const count = await linkSnapshot();
  console.log(`PASS ${count} hook/MCP module graphs link from a bare snapshot`);
  for (const name of ["hooks/pricing.mjs", "hooks/lib/memory-start.mjs", "lib/memory-pins.mjs", "mcp.mjs"]) {
    const path = join(snapshot, name);
    const source = readFileSync(path, "utf8");
    // Mutate only the disposable snapshot: prove the guard names the importing module and package.
    writeFileSync(path, `${source}\nimport "yaml";\n`);
    await assert.rejects(linkSnapshot(), error => error.message.includes(name) && error.message.includes("unresolved package 'yaml'"));
    writeFileSync(path, source);
    console.log(`PASS rejects bare yaml in ${name}`);
  }
  await linkSnapshot();
  console.log("PASS restored snapshot links again");
} finally {
  rmSync(work, { recursive: true, force: true });
}

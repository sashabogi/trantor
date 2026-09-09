#!/usr/bin/env node
// Every file the CLI can reach must actually be in the published tarball.
//
// Why this exists. package.json has a `files` allowlist, and bin/cli.mjs is a thin dispatcher that
// spawns its subcommands BY PATH at runtime — `run("bin/doctor.mjs")`, `await import(join(ROOT,
// "lib/project.mjs"))`. Nothing resolves at import time, so `trantor --version` loads none of it and
// the whole suite runs from the repo where every file is present by definition. Add a directory to
// the tree, forget it in `files`, and the tarball ships without it: green tests, green CI, green
// publish, and the subcommand throws ENOENT the first time a user runs it.
//
// This is the gate that replaces the human glance at a release. It reads the dispatch targets out of
// cli.mjs and asserts each one is in what `npm pack` would actually ship.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};

// Paths cli.mjs hands to spawn() or import(). Top-level dirs are the ones `files` governs.
const DISPATCH = /"((?:bin|lib|hooks|hub|skills|deploy|configs|engine)\/[A-Za-z0-9_./-]+)"/g;
const cli = readFileSync(new URL("../../bin/cli.mjs", import.meta.url), "utf8");
const referenced = [...new Set([...cli.matchAll(DISPATCH)].map(m => m[1]))].sort();

console.log(`\ncli.mjs dispatches to ${referenced.length} paths`);
ok("the dispatch list is non-empty (the regex still matches the file)", referenced.length > 20,
  `found ${referenced.length}`);

// What `npm pack` would really ship. --dry-run so nothing is written.
const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: ROOT, encoding: "utf8" });
ok("npm pack --dry-run succeeds", packed.status === 0, (packed.stderr || "").trim().slice(0, 200));

let shipped = new Set();
try {
  const meta = JSON.parse(packed.stdout)[0];
  shipped = new Set((meta.files || []).map(f => f.path));
  console.log(`tarball: ${meta.filename} — ${meta.entryCount} entries`);
} catch (error) {
  ok("npm pack --json is parseable", false, String(error).slice(0, 160));
}

console.log("\nevery dispatch target ships");
const missing = referenced.filter(p => !shipped.has(p));
ok("no file the CLI can spawn is missing from the tarball", missing.length === 0,
  missing.length ? `MISSING: ${missing.join(", ")}` : `all ${referenced.length} present`);

// The two the plugin surface needs, which no subcommand references by path.
console.log("\nthe plugin manifest ships (update-check reads it at runtime)");
for (const p of [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", "package.json"]) {
  ok(`${p} is in the tarball`, shipped.has(p));
}

// The version skew that shipped in 0.18.50 and would have told every user they were current.
console.log("\nthe two version files agree");
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const plugin = JSON.parse(readFileSync(new URL("../../.claude-plugin/plugin.json", import.meta.url), "utf8")).version;
ok("package.json and .claude-plugin/plugin.json carry the same version", pkg === plugin,
  `package.json=${pkg} plugin.json=${plugin}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

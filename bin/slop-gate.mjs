#!/usr/bin/env node
// trantor slop-gate — the anti-slop lint, scoped to YOUR CHANGES (a gate that fails on code you
// did not touch teaches agents to ignore it). Rules: tools/oxlint/anti-slop + the comment policy (#6450).
//   node bin/slop-gate.mjs [--all]                 # changed + untracked files; --all = whole surface (advisory)
//   node bin/slop-gate.mjs --surface desktop/src   # ONE paid-off surface in full (hard gate in npm test)
import { execSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ALL = process.argv.includes("--all");
// A surface that burned its debt down to zero (desktop/src, #4798) is gated in FULL so it stays paid.
const SURFACE_AT = process.argv.indexOf("--surface");
const SURFACE = SURFACE_AT > -1 ? process.argv[SURFACE_AT + 1] : null;
const LINTABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const COMMENTABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|rs|sh)$/;
// Mirrors oxlint.config.ts ignorePatterns: a surface made only of these is gated on comments alone.
const OXLINT_IGNORED = /^(\.claude\/|\.dsh\/|node_modules\/|desktop\/node_modules\/|desktop\/src-tauri\/|desktop\/dist\/|tools\/oxlint\/anti-slop\/|engine\/|kimi\/skills\/|docs\/|hub\.mjs$|mcp\.mjs$|ui\.html$)/;
const SKIP_DIRS = new Set(["node_modules", "target", "dist", ".git"]);

function sh(cmd) {
  try { return execSync(cmd, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim(); }
  catch { return ""; }
}

function walk(p, out) {
  let st;
  try { st = statSync(p); } catch { return out; }
  if (st.isDirectory()) { for (const c of readdirSync(p)) { if (!SKIP_DIRS.has(c)) walk(join(p, c), out); } }
  else if (COMMENTABLE.test(p)) out.push(p);
  return out;
}

// ---- comment policy (#6450): at most two lines of why, a card link is fine, no dates, no incident
// diaries. Mechanically: a comment block over 4 lines or a comment line carrying a date errors.
const MAX_BLOCK = 4;
const DATE = /\b20\d\d-\d\d\b/;
function commentPolicy(file) {
  const hits = [];
  const sh = extname(file) === ".sh";
  const isComment = sh ? (l) => /^\s*#(?!!)/.test(l) : (l) => /^\s*(\/\/|\/\*|\*|\*\/)/.test(l);
  const lines = readFileSync(file, "utf8").split("\n");
  let run = 0;
  const closeRun = (endIdx) => {
    if (run > MAX_BLOCK) hits.push(`${file}:${endIdx - run + 1}:1: error comment-policy(long-block): ${run} comment lines (max ${MAX_BLOCK}) — two lines of why, the story goes on the card`);
    run = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!isComment(l)) { closeRun(i); continue; }
    run++;
    if (DATE.test(l)) hits.push(`${file}:${i + 1}:1: error comment-policy(dated): a date in a comment — cite the card, not the day`);
  }
  closeRun(lines.length);
  return hits;
}

let files;
if (SURFACE) {
  files = walk(SURFACE, []);
} else if (ALL) {
  files = walk(".", []);
} else {
  const changed = sh("git diff --name-only HEAD");
  const untracked = sh("git ls-files --others --exclude-standard");
  files = [...new Set([...changed.split("\n"), ...untracked.split("\n")])].filter(f => f && COMMENTABLE.test(f));
  if (!files.length) { console.log("slop-gate: no lintable changes — pass."); process.exit(0); }
}
const oxFiles = files.filter(f => LINTABLE.test(f) && !OXLINT_IGNORED.test(f.replace(/^\.\//, "")));

let hits = [];
let warnings = 0;
if (oxFiles.length) {
  // oxlint applies oxlint.config.ts ignorePatterns even to explicitly-passed files (verified).
  const args = SURFACE ? [SURFACE] : ALL ? ["."] : oxFiles;
  const r = spawnSync("npx", ["oxlint", ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const out = (r.stdout || "") + (r.stderr || "");
  // A gate that cannot run must not read as clean: oxlint prints no run summary, so "it ran" is read
  // from its exit contract (0 = clean, 1 = diagnostics printed). Anything else is not a verdict.
  const diag = /:\d+:\d+: (error|warning)\b/.test(out);
  const ran = !r.error && !/^npm (error|ERR!)/m.test(out) && !/No files found to lint/.test(out)
    && (r.status === 0 || (r.status === 1 && diag));
  if (!ran) {
    console.error(out.trim().split("\n").slice(-6).join("\n"));
    console.error("\nslop-gate: could not run oxlint, so there is no verdict and this is NOT clean. Install deps in this checkout (pnpm install) and rerun.");
    process.exit(2);
  }
  hits = out.split("\n").filter(l => /error\s+anti-slop\(/.test(l));
  warnings = out.split("\n").filter(l => /\bwarning\b/.test(l)).length;
}
for (const f of files) hits.push(...commentPolicy(f));

if (hits.length) {
  console.log(hits.join("\n"));
  const where = SURFACE ? `in ${SURFACE} (a zero-debt surface — keep it at zero)` : "in your changes";
  console.log(`\nslop-gate: ${hits.length} anti-slop error(s) ${where} — fix them (or state the SAFETY invariant) before moving the card to testing.`);
  process.exit(1);
}
console.log(`slop-gate${SURFACE ? ` (${SURFACE})` : ""}: clean${warnings ? ` (${warnings} advisory warning(s) — not gating)` : ""}${oxFiles.length ? "" : " (comment policy only — no oxlint-lintable files here)"}.`);
process.exit(0);

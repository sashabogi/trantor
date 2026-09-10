#!/usr/bin/env node
// trantor slop-gate — the anti-slop lint, scoped to YOUR CHANGES (#4798, #6450).
//   node bin/slop-gate.mjs                        # changed + untracked files (the crew gate)
//   node bin/slop-gate.mjs --all                  # the whole configured surface (advisory audit)
//   node bin/slop-gate.mjs --surface desktop/src  # ONE paid-off surface in full (hard gate in npm test)
import { execSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ALL = process.argv.includes("--all");
// A paid-off surface (desktop/src, #4798) is gated in FULL so it stays paid; npm test runs this.
const SURFACE_AT = process.argv.indexOf("--surface");
const SURFACE = SURFACE_AT > -1 ? process.argv[SURFACE_AT + 1] : null;
const LINTABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
// Comment policy (doctrine §7, #6450): at most two lines of why plus a card link; the incident
// story lives on the card. Mechanically: a block over 4 lines or a dated line (2026-) errors.
const COMMENTABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|rs|sh)$/;
const COMMENT_MAX_LINES = 4;
const DATED = /\b20\d\d-\d\d(-\d\d)?\b/;
const SKIP_DIR = /(^|\/)(node_modules|target|dist|\.git|\.claude|\.dsh|engine|tools\/oxlint|kimi)(\/|$)/;

function sh(cmd) {
  try { return execSync(cmd, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim(); }
  catch { return ""; }
}

let args;
if (SURFACE) {
  args = [SURFACE];
} else if (ALL) {
  args = ["."];
} else {
  const changed = sh("git diff --name-only HEAD");
  const untracked = sh("git ls-files --others --exclude-standard");
  const files = [...new Set([...changed.split("\n"), ...untracked.split("\n")])]
    .filter(f => f && COMMENTABLE.test(f));
  if (!files.length) { console.log("slop-gate: no lintable changes — pass."); process.exit(0); }
  args = files;
}

function listFiles(root, out = []) {
  let st; try { st = statSync(root); } catch { return out; }
  if (st.isDirectory()) { if (!SKIP_DIR.test(root)) for (const c of readdirSync(root)) listFiles(join(root, c), out); }
  else if (COMMENTABLE.test(root)) out.push(root);
  return out;
}

// Comment blocks: consecutive line comments (// or #), or one /* ... */ span. A block is measured
// in lines and scanned for a date; the first offence per block is reported, oxlint-style.
function commentOffences(file) {
  const text = readFileSync(file, "utf8");
  const hash = /\.sh$/.test(file);
  const lines = text.split("\n");
  const hits = [];
  let start = 0, len = 0, dated = 0, span = false;
  const flush = () => {
    if (len > COMMENT_MAX_LINES) hits.push(`${file}:${start}:1: error comment-policy(block-too-long): ${len} lines of comment; the limit is ${COMMENT_MAX_LINES}. Say why in two lines and link the card`);
    else if (dated) hits.push(`${file}:${dated}:1: error comment-policy(dated-comment): a date in a comment is an incident diary; it belongs on the card log or docs/CONTRACT-*.md`);
    len = 0; dated = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (span) {
      len++; if (!dated && DATED.test(t)) dated = i + 1;
      if (t.includes("*/")) { span = false; flush(); }
      continue;
    }
    const line = hash ? (t.startsWith("#") && !t.startsWith("#!")) : t.startsWith("//");
    if (line) { if (!len) start = i + 1; len++; if (!dated && DATED.test(t)) dated = i + 1; continue; }
    if (!hash && t.startsWith("/*")) {
      if (len) flush();
      start = i + 1; len = 1; span = !t.includes("*/"); if (DATED.test(t)) dated = i + 1;
      if (!span) flush();
      continue;
    }
    if (len) flush();
  }
  if (len) flush();
  return hits;
}

const commentTargets = SURFACE ? listFiles(SURFACE) : ALL ? listFiles(".") : args.filter(f => COMMENTABLE.test(f));
const commentHits = commentTargets.flatMap(commentOffences);

// oxlint applies oxlint.config.ts ignorePatterns even to explicitly-passed files (verified), so
// excluded legacy files (hub.mjs, mcp.mjs) stay excluded here too.
const oxArgs = SURFACE || ALL ? args : args.filter(f => LINTABLE.test(f));
const r = oxArgs.length ? spawnSync("npx", ["oxlint", ...oxArgs], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  : { status: 0, stdout: "", stderr: "" };
const out = (r.stdout || "") + (r.stderr || "");
// A gate that cannot run must not read as clean (#5966: an npm error's empty output once read as
// zero hits). oxlint's exit contract is the only proof it ran: 0 = clean, 1 = diagnostics printed.
const diag = /:\d+:\d+: (error|warning)\b/.test(out);
// "No files found" is oxlint saying every target is on its ignore list (hub.mjs, src-tauri):
// it ran, there is nothing for anti-slop to judge, and the comment policy still gates.
const nothingToLint = /No files found to lint/.test(out);
const ran = !r.error && !/^npm (error|ERR!)/m.test(out)
  && (r.status === 0 || (r.status === 1 && diag) || nothingToLint);
if (!ran) {
  console.error(out.trim().split("\n").slice(-6).join("\n"));
  console.error("\nslop-gate: could not run oxlint, so there is no verdict and this is NOT clean. Install deps in this checkout (pnpm install) and rerun.");
  process.exit(2);
}
const hits = [...(nothingToLint ? [] : out.split("\n").filter(l => /error\s+anti-slop\(/.test(l))), ...commentHits];

if (hits.length) {
  console.log(hits.join("\n"));
  const where = SURFACE ? `in ${SURFACE} (a zero-debt surface — keep it at zero)` : "in your changes";
  console.log(`\nslop-gate: ${hits.length} error(s) ${where} (${hits.length - commentHits.length} anti-slop, ${commentHits.length} comment-policy) — fix them (or state the SAFETY invariant) before moving the card to testing.`);
  process.exit(1);
}
const warnings = out.split("\n").filter(l => /\bwarning\b/.test(l)).length;
console.log(`slop-gate${SURFACE ? ` (${SURFACE})` : ""}: clean${warnings ? ` (${warnings} advisory warning(s) — not gating)` : ""}.`);
process.exit(0);

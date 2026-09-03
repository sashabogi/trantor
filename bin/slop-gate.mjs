#!/usr/bin/env node
// trantor slop-gate — the anti-slop lint, scoped to YOUR CHANGES.
//
//   node bin/slop-gate.mjs           # lint changed + untracked lintable files (the crew gate)
//   node bin/slop-gate.mjs --all     # lint the whole configured surface (advisory audit)
//   node bin/slop-gate.mjs --surface desktop/src   # lint ONE paid-off surface in full (hard gate in npm test)
//
// The rules are the vendored dmmulroy/anti-slop set (tools/oxlint/anti-slop — ours to tune):
// they mechanically reject low-evidence AI patterns — unexplained type assertions, unknown
// laundering, runtime typeof instead of boundary decoding, Reflect tricks, module mocking.
// Diff-scoped ON PURPOSE: the legacy surface carries known debt (carded), and a gate that fails
// on code you didn't touch teaches agents to ignore the gate. New work meets the bar; old debt
// burns down on its own card. Stock eslint warnings stay ADVISORY — only anti-slop errors gate.
import { execSync, spawnSync } from "node:child_process";

const ALL = process.argv.includes("--all");
// A surface that has burned its debt down to zero (desktop/src, #4798) is gated in FULL, not by
// diff: the whole point of paying it off is that it stays paid. npm test runs this.
const SURFACE_AT = process.argv.indexOf("--surface");
const SURFACE = SURFACE_AT > -1 ? process.argv[SURFACE_AT + 1] : null;
const LINTABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

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
    .filter(f => f && LINTABLE.test(f));
  if (!files.length) { console.log("slop-gate: no lintable changes — pass."); process.exit(0); }
  args = files;
}

// oxlint applies oxlint.config.ts ignorePatterns even to explicitly-passed files (verified), so
// excluded legacy files (hub.mjs, mcp.mjs) stay excluded here too.
const r = spawnSync("npx", ["oxlint", ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const out = (r.stdout || "") + (r.stderr || "");
// A gate that cannot run must not read as clean. Witnessed 2026-09-03: a seat worktree with no
// node_modules made `npx oxlint` die with an npm error, the empty output had zero hits, and
// "slop-gate clean" rode into main on 23 real anti-slop errors. the exit contract below is the
// only proof it ran; without it, exit 2 and say so.
// oxlint prints no run summary here (diagnostics only), so "it ran" is read from its exit
// contract: 0 = clean, 1 = diagnostics printed. An npm error, a launch error, an exit code oxlint
// never uses, a 1 with no diagnostic line, or "No files found" is not a verdict.
const diag = /:\d+:\d+: (error|warning)\b/.test(out);
const ran = !r.error && !/^npm (error|ERR!)/m.test(out) && !/No files found to lint/.test(out)
  && (r.status === 0 || (r.status === 1 && diag));
if (!ran) {
  console.error(out.trim().split("\n").slice(-6).join("\n"));
  console.error("\nslop-gate: could not run oxlint, so there is no verdict and this is NOT clean. Install deps in this checkout (pnpm install) and rerun.");
  process.exit(2);
}
const hits = out.split("\n").filter(l => /error\s+anti-slop\(/.test(l));

if (hits.length) {
  console.log(hits.join("\n"));
  const where = SURFACE ? `in ${SURFACE} (a zero-debt surface — keep it at zero)` : "in your changes";
  console.log(`\nslop-gate: ${hits.length} anti-slop error(s) ${where} — fix them (or state the SAFETY invariant) before moving the card to testing.`);
  process.exit(1);
}
const warnings = out.split("\n").filter(l => /\bwarning\b/.test(l)).length;
console.log(`slop-gate${SURFACE ? ` (${SURFACE})` : ""}: clean${warnings ? ` (${warnings} advisory warning(s) — not gating)` : ""}.`);
process.exit(0);

// #7750 — seat-side hollow-move check: the hub is remote and cannot see a seat's worktree, so on
// a move to testing/done mcp.mjs diffs the worktree against the sha recorded at `doing`, reads
// checklist ticks and scans the note for a test command. All missing + no declared no-code
// outcome → the move still lands, note prefixed HOLLOW:, assigner told on the bus.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contractBase } from "../../bin/crew-payload.mjs";

// A "test command" is a command shape or a pass count — the note contract already demands both.
const TEST_CMD_RE = /(node\s+test\/|npm\s+(run\s+)?test|pnpm\s+test|yarn\s+test|vitest|pytest|go\s+test|cargo\s+test|make\s+test|\b\d+\s*\/\s*\d+\b|\b\d+\s+passed\b)/i;
// Declared no-code outcomes (#7750: docs, investigation, refusal, answered on the bus) — a card
// that says one of these is NEVER flagged, however empty its worktree is.
const NOCODE_RE = /\b(no[- ]code|docs?[- ]only|investigat\w*|read[- ]only|research[- ]only|analysis[- ]only|answered (on|in) the bus|refus\w+|declin\w+|won'?t fix)\b/i;

// #7754: the note names the sha it verified against, or a gate cannot tell green-on-the-wrong-base
// from green. Required on its own, not only when every other piece of evidence is missing too.
const VERIFIED_AT_RE = /\bverified at\s+([0-9a-f]{7,40})\b/i;
const VERIFIED_AT_MISSING = "verified-at sha in the note";

export const hasTestCommand = (note) => TEST_CMD_RE.test(String(note || ""));
export const declaresNoCode = (note) => NOCODE_RE.test(String(note || ""));
export const namesVerifiedSha = (note) => VERIFIED_AT_RE.test(String(note || ""));

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

// Per-worktree, keyed by card id: <git-dir> is the worktree's OWN dir under a linked worktree
// (…/.git/worktrees/<seat>), so seats never share each other's bases.
const basePath = (cwd) => join(git(cwd, ["rev-parse", "--git-dir"]), "hollow-base.json");

// Snapshot HEAD when a card is taken (doing); the testing/done check diffs against this sha.
export function markDoing(cwd, id) {
  try {
    const p = basePath(cwd);
    let map = {};
    try { map = JSON.parse(readFileSync(p, "utf8")); } catch { /* first card in this worktree */ }
    map[id] = git(cwd, ["rev-parse", "HEAD"]);
    writeFileSync(p, JSON.stringify(map));
  } catch { /* not a git worktree — no base recorded, and hollowVerdict fails open */ }
}

// Verdict for a testing/done move. checked:false = no usable base (pre-#7750 card, non-git cwd,
// base sha lost to a rebase) — fail open rather than flag on a base we cannot trust.
export function hollowVerdict(cwd, id, note, checklist) {
  let base;
  try { base = JSON.parse(readFileSync(basePath(cwd), "utf8"))[id]; } catch { return { checked: false, hollow: false, missing: [] }; }
  if (!base) return { checked: false, hollow: false, missing: [] };
  const missing = [];
  try {
    // `git diff <base>` covers committed AND uncommitted tracked changes vs the taken-sha.
    if (!git(cwd, ["diff", "--name-only", base, "--"])) missing.push("diff");
    if (!git(cwd, ["ls-files", "--others", "--exclude-standard"])) missing.push("new files");
  } catch { return { checked: false, hollow: false, missing: [] }; }
  if (!(checklist || []).some((c) => c.done)) missing.push("ticked checklist items");
  if (!hasTestCommand(note)) missing.push("test command in the note");
  const evidenceless = missing.length === 4;
  const unanchored = !namesVerifiedSha(note);
  // The flag names only what tripped it: the four evidence gaps together, or the missing sha alone.
  if (!evidenceless) missing.length = 0;
  if (unanchored) missing.push(VERIFIED_AT_MISSING);
  const hollow = (evidenceless || unanchored) && !declaresNoCode(note);
  return { checked: true, hollow, missing };
}

// #7968: blast radius on the testing/done move — `graft blast` over the card's committed diff, so
// the note says how many files depend on what changed. Fails open to `blast: unavailable` when graft
// is absent, slow (2.5s box), has no index here, or the base cannot be resolved.
export const BLAST_TIMEOUT_MS = 2500;
const BLAST_PATHS_MAX = 40;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The base is the contract's `base: <sha>` when this worktree can resolve it, else the merge base
// of main and HEAD — never origin/main, which trails the orchestrator's unpushed integration head.
export function blastBase(cwd, messages) {
  const declared = contractBase(messages);
  if (declared) {
    try { git(cwd, ["cat-file", "-e", `${declared}^{commit}`]); return declared; } catch { /* not here: fall through */ }
  }
  try { return git(cwd, ["merge-base", "main", "HEAD"]); } catch { return ""; }
}

// One line for the card note. A silent zero on a config file is the false comfort the gate exists
// to remove, so an unindexed change is named, and zero dependents is said as zero.
export function blastLine(b) {
  if (!b || b.unavailable) return "blast: unavailable";
  const unindexed = b.unindexed || [];
  const indexed = (b.changed || []).filter((p) => !unindexed.includes(p));
  if (!indexed.length && !unindexed.length) return `blast: no committed changes since ${String(b.base || "").slice(0, 7)}`;
  if (!indexed.length) return `blast: not in the graph (${unindexed.join(", ")})`;
  const n = b.dependents || 0;
  const tail = unindexed.length ? ` (${unindexed.join(", ")} not in the graph)` : "";
  return `blast: ${plural(n, "file depends", "files depend")} on the ${indexed.length} changed${tail}`;
}

// Runs graft and shapes the field the move posts: { base, changed[], unindexed[], dependents } or
// { unavailable: true }. GRAFT_BIN lets a drill point at an absent or slow binary.
export function blastRadius(cwd, messages) {
  const base = blastBase(cwd, messages);
  // No recorded base (a card taken before #7750, or a move from a non-git cwd): nothing to measure
  // and nothing to say, so the note keeps the seat's words untouched. Graft absent or slow WITH a
  // base is the fail-open case below, and that one does say unavailable.
  if (!base) return null;
  const r = spawnSync(process.env.GRAFT_BIN || "graft", ["blast", "--base", base, "--depth", "all", "--format", "json"],
    { cwd, encoding: "utf8", timeout: BLAST_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) return { unavailable: true };
  let j;
  try { j = JSON.parse(r.stdout); } catch { return { unavailable: true }; }
  const changed = (j.changed || []).map((c) => String(c.path || "")).filter(Boolean);
  const unindexed = (j.unindexed || []).map(String).filter((p) => changed.includes(p));
  const dependents = new Set((j.impacted || []).map((i) => String(i.path || "")).filter((p) => p && !changed.includes(p))).size;
  return { base, changed: changed.slice(0, BLAST_PATHS_MAX), unindexed: unindexed.slice(0, BLAST_PATHS_MAX), dependents };
}

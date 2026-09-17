// #7750 — seat-side hollow-move check: the hub is remote and cannot see a seat's worktree, so on
// a move to testing/done mcp.mjs diffs the worktree against the sha recorded at `doing`, reads
// checklist ticks and scans the note for a test command. All missing + no declared no-code
// outcome → the move still lands, note prefixed HOLLOW:, assigner told on the bus.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A "test command" is a command shape or a pass count — the note contract already demands both.
const TEST_CMD_RE = /(node\s+test\/|npm\s+(run\s+)?test|pnpm\s+test|yarn\s+test|vitest|pytest|go\s+test|cargo\s+test|make\s+test|\b\d+\s*\/\s*\d+\b|\b\d+\s+passed\b)/i;
// Declared no-code outcomes (#7750: docs, investigation, refusal, answered on the bus) — a card
// that says one of these is NEVER flagged, however empty its worktree is.
const NOCODE_RE = /\b(no[- ]code|docs?[- ]only|investigat\w*|read[- ]only|research[- ]only|analysis[- ]only|answered (on|in) the bus|refus\w+|declin\w+|won'?t fix)\b/i;

export const hasTestCommand = (note) => TEST_CMD_RE.test(String(note || ""));
export const declaresNoCode = (note) => NOCODE_RE.test(String(note || ""));

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
  const hollow = missing.length === 4 && !declaresNoCode(note);
  return { checked: true, hollow, missing };
}

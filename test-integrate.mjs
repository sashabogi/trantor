#!/usr/bin/env node
// Integration drills, against REAL git repos in a temp dir.
//
// The stakes here are the highest in the product: this is the code path that can put an agent's
// work on a remote without a human in the loop. Every refusal is drilled, because a refusal that
// silently does not happen is indistinguishable from success until it is on main.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "trantor-integrate-"));
process.env.AGENT_BUS_DIR = join(root, "bus");
mkdirSync(process.env.AGENT_BUS_DIR, { recursive: true });

const { seatWorktrees, commitSeatWork, seatAhead, mergeSeat, verify, git } =
  await import("./lib/integrate.mjs");

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };
const sh = (cwd, ...a) => execFileSync(a[0], a.slice(1), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

console.log("# trantor integration drills");

// a project repo with one commit on main
const repo = join(root, "proj");
mkdirSync(repo, { recursive: true });
sh(repo, "git", "init", "-q", "-b", "main");
sh(repo, "git", "config", "user.email", "o@t.local");
sh(repo, "git", "config", "user.name", "orchestrator");
writeFileSync(join(repo, "a.txt"), "one\n");
sh(repo, "git", "add", "-A");
sh(repo, "git", "commit", "-q", "-m", "base");

// two seats, each in its own worktree on its own branch — exactly what crew-runner creates
const wtBase = join(process.env.AGENT_BUS_DIR, "worktrees", "proj");
mkdirSync(wtBase, { recursive: true });
for (const agent of ["glm", "codex"]) {
  sh(repo, "git", "worktree", "add", "-q", "-b", `seat/${agent}`, join(wtBase, agent), "main");
}

console.log("\nThe worktree directory IS the seat registry:");
{
  const seats = seatWorktrees("proj");
  ok("both seats are found", seats.length === 2, JSON.stringify(seats.map(s => s.agent)));
  ok("…by their agent name", seats.map(s => s.agent).sort().join(",") === "codex,glm");
}

console.log("\nA seat's work is committed AS THAT SEAT, so blame stays truthful:");
{
  const seats = seatWorktrees("proj");
  const glm = seats.find(s => s.agent === "glm");
  writeFileSync(join(glm.dir, "b.txt"), "from glm\n");
  const r = commitSeatWork(glm);
  ok("it commits when the worktree is dirty", r.committed === true);
  const author = git(glm.dir, ["log", "-1", "--format=%an"]);
  ok("the author is the seat, not the operator", author === "glm", author);
  const again = commitSeatWork(glm);
  ok("a clean worktree commits nothing", again.committed === false);
}

console.log("\nMerging collects what a seat is ahead by:");
{
  const seats = seatWorktrees("proj");
  const glm = seats.find(s => s.agent === "glm");
  const { branch, ahead } = seatAhead(glm, "main");
  ok("the seat reports its branch", branch === "seat/glm", branch);
  ok("…and how far ahead it is", ahead === 1, String(ahead));
  const m = mergeSeat(repo, "seat/glm");
  ok("the merge lands", m.merged === true && m.conflict === false);
  ok("the file arrives on main", sh(repo, "git", "show", "HEAD:b.txt").trim() === "from glm");
}

console.log("\nTwo seats on the same lines is a COLLISION, not something to resolve silently:");
{
  // both seats change the same line of the same file, from the same base
  const seats = seatWorktrees("proj");
  const codex = seats.find(s => s.agent === "codex");
  writeFileSync(join(codex.dir, "a.txt"), "codex version\n");
  commitSeatWork(codex);
  writeFileSync(join(repo, "a.txt"), "main version\n");
  sh(repo, "git", "commit", "-qam", "main edit");

  const m = mergeSeat(repo, "seat/codex");
  ok("the conflict is reported, not swallowed", m.conflict === true);
  ok("…and the tree is left clean rather than half-merged",
    sh(repo, "git", "status", "--porcelain").trim() === "", sh(repo, "git", "status", "--porcelain"));
  ok("main keeps its own content", sh(repo, "git", "show", "HEAD:a.txt").trim() === "main version");
}

console.log("\nVerify is a GATE, and it reports what broke:");
{
  const green = verify(repo, "exit 0");
  ok("a passing command verifies", green.ok === true);
  const red = verify(repo, "echo 'boom: 3 failed' >&2; exit 1");
  ok("a failing command does NOT verify", red.ok === false);
  ok("…and the reason is carried back for the operator", /boom/.test(red.tail || ""), red.tail);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} integrate: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

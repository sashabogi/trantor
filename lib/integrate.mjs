// The orchestrator's integration pass.
//
// This is not a new idea, it is the thing Trantor already does by hand: seats work in their own
// worktrees on seat/<agent>, the orchestrator collects that work, checks the seats did not step on
// each other, proves the result, and only then pushes. Automating it changes who runs the steps,
// never what the steps are.
//
// Every stage can refuse. A refusal is the point of the stage existing, so each one reports WHY
// rather than failing quietly and leaving a half-integrated tree.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const busDir = () => process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus");

export function git(cwd, args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(" ")} failed: ${(e.stderr || e.message || "").toString().trim()}`);
  }
}

/** Every seat that has a worktree for this project. The directory IS the registry — crew-runner
 *  creates it and nothing else writes there. */
export function seatWorktrees(project, root = busDir()) {
  const base = join(root, "worktrees", project);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => ({ agent: d.name, dir: join(base, d.name) }))
    .filter(w => existsSync(join(w.dir, ".git")));
}

/** Uncommitted work in a seat's worktree, committed AS THAT SEAT.
 *
 *  Authorship is the whole reason this is not a plain `git commit`: once the orchestrator starts
 *  integrating automatically, "who wrote this" stops being obvious from context and git blame
 *  becomes the only durable answer. A human tweak on top lands as its own commit, authored to the
 *  human, so the two never blur. */
export function commitSeatWork(w, { message } = {}) {
  const dirty = git(w.dir, ["status", "--porcelain"]);
  if (!dirty) return { agent: w.agent, committed: false, reason: "nothing to commit" };
  git(w.dir, ["add", "-A"]);
  const subject = message || `${w.agent}: landed work from its worktree`;
  git(w.dir, [
    "-c", `user.name=${w.agent}`,
    "-c", `user.email=${w.agent}@trantor.local`,
    "commit", "-q",
    "--author", `${w.agent} <${w.agent}@trantor.local>`,
    "-m", subject,
  ]);
  return { agent: w.agent, committed: true, sha: git(w.dir, ["rev-parse", "--short", "HEAD"]) };
}

/** What this seat has that the integration branch does not. */
export function seatAhead(w, base = "main") {
  const branch = git(w.dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const count = git(w.dir, ["rev-list", "--count", `${base}..${branch}`], { allowFail: true });
  return { branch, ahead: Number(count || 0) };
}

/** Merge one seat's branch into the current checkout.
 *
 *  A conflict is NOT an error to swallow. Two seats editing the same lines is exactly the collision
 *  the overseer exists to surface, so the merge is aborted and reported rather than left half-done
 *  for a human to discover in a broken tree. */
export function mergeSeat(repo, branch) {
  const before = git(repo, ["rev-parse", "HEAD"]);
  try {
    git(repo, ["merge", "--no-edit", branch]);
    const after = git(repo, ["rev-parse", "HEAD"]);
    return { branch, merged: before !== after, conflict: false };
  } catch (e) {
    git(repo, ["merge", "--abort"], { allowFail: true });
    return { branch, merged: false, conflict: true, detail: String(e.message || e).slice(0, 400) };
  }
}

/** Proof, before anything leaves the machine.
 *
 *  Pushing unverified work is the one thing the Definition of Done forbids outright, so this is a
 *  gate and not a report: a red run means push does not happen, whatever the dial says. */
export function verify(repo, cmd = "npm test") {
  try {
    execFileSync("/bin/bash", ["-lc", cmd], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30 * 60 * 1000 });
    return { ok: true, cmd };
  } catch (e) {
    const out = ((e.stdout || "") + (e.stderr || "")).toString();
    return { ok: false, cmd, tail: out.trim().split("\n").slice(-12).join("\n") };
  }
}

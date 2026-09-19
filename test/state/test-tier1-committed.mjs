#!/usr/bin/env node
// Trantor State — tier 1 sees work a seat COMMITTED, not only work left dirty (#8069).
//
// §4.8 specifies tier 1 as `git status --porcelain` plus `git diff --name-only HEAD`, every turn,
// unconditional, "ground truth rather than testimony". Both of those measure the working tree
// AGAINST HEAD. A seat that commits moves HEAD along with its work, so both come back empty — and
// every seat is instructed to commit early and often precisely so a cut cannot erase it. Tier 1 was
// therefore blind on the ordinary flow, not a corner of it.
//
// Measured, not theorised: the first real Phase-2a run (card #6448) rewrote desktop/src-tauri/src/lib.rs
// from 7,997 lines to 135 across 15 modules over four commits, and its sidecar recorded `files: {}`.
// Run in that worktree afterwards, `git status --porcelain` returned 0 bytes and `git diff --name-only
// HEAD` returned 0 lines. Nothing was broken; tier 1 was asking a question a committing seat always
// answers "nothing" to.
//
// That matters beyond a missing field. §4.8 also makes tier 1 the only thing that EXPIRES a stale
// `verified` credit, because it is the only pass that runs every single turn — so while it saw
// nothing, Risk R12 (rated HIGH: "a credit that outlives the file it describes") had no mitigation.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tier1Files } from "../../lib/state/driver.mjs";
import { gitHead, hashPaths } from "../../lib/state/store.mjs";
import { harness } from "./_helpers.mjs";

const { ok, done } = harness();
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

const repo = mkdtempSync(join(tmpdir(), "tier1-"));
try {
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "drill@trantor"], repo);
  git(["config", "user.name", "drill"], repo);
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(["add", "-A"], repo);
  git(["commit", "-qm", "seed"], repo);

  const headAtStart = gitHead(repo);
  ok("gitHead returns a real sha for a repo with a commit", /^[0-9a-f]{40}$/.test(headAtStart || ""), String(headAtStart));

  console.log("\nthe dirty case — unchanged behaviour, and it must stay working");
  {
    writeFileSync(join(repo, "dirty-a.mjs"), "a\n");
    writeFileSync(join(repo, "dirty-b.mjs"), "b\n");
    const files = tier1Files({ files: {} }, repo, {}, headAtStart);
    ok("a turn that edits two files leaves both touched", files["dirty-a.mjs"]?.touched === true && files["dirty-b.mjs"]?.touched === true,
      JSON.stringify(files));
    ok("tier 1 never sets verified — touching is not evidence",
      !Object.values(files).some(f => f.verified === true), JSON.stringify(files));
  }

  console.log("\nthe COMMITTED case — the one that was blind");
  {
    // The #6448 shape: the seat does the work and commits it, exactly as instructed.
    git(["add", "-A"], repo);
    git(["commit", "-qm", "seat step 1"], repo);
    writeFileSync(join(repo, "committed-c.mjs"), "c\n");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "seat step 2"], repo);

    // Ground the premise rather than asserting it: BOTH commands §4.8 named are now empty.
    ok("git status is empty after the seat commits (the premise)", git(["status", "--porcelain"], repo).trim() === "");
    ok("git diff HEAD is empty too (the premise)", git(["diff", "--name-only", "HEAD"], repo).trim() === "");

    const files = tier1Files({ files: {} }, repo, {}, headAtStart);
    ok("a file created and COMMITTED this step is touched", files["committed-c.mjs"]?.touched === true, JSON.stringify(files));
    ok("…and so are the files committed from the dirty state", files["dirty-a.mjs"]?.touched === true, JSON.stringify(files));
    ok("…while a file untouched since the step began is NOT", files["seed.txt"] === undefined, JSON.stringify(files));
  }

  console.log("\ncredit expiry — R12's only mitigation, on committed work too");
  {
    const head = gitHead(repo);
    const shas = hashPaths(["committed-c.mjs"], repo);
    const state = { files: { "committed-c.mjs": { verified: true, hash: shas.get("committed-c.mjs") } } };

    const unchanged = tier1Files(state, repo, {}, head);
    ok("an untouched credited file keeps its credit", unchanged["committed-c.mjs"] === undefined, JSON.stringify(unchanged));

    writeFileSync(join(repo, "committed-c.mjs"), "c changed\n");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "edited after credit"], repo);
    const expired = tier1Files(state, repo, {}, head);
    ok("a credited file edited AND COMMITTED loses its credit", expired["committed-c.mjs"]?.verified === false, JSON.stringify(expired));
    ok("…and is reported touched in the same pass", expired["committed-c.mjs"]?.touched === true, JSON.stringify(expired));
  }

  console.log("\ndegradation — a reader that cannot answer must not throw");
  {
    const files = tier1Files({ files: {} }, repo, {}, null);
    ok("a null starting HEAD yields the dirty-only answer, never a throw", typeof files === "object");
    const nowhere = tier1Files({ files: {} }, join(repo, "does-not-exist"), {}, headAtStart);
    ok("a cwd that is not a repo yields {}, never a throw", Object.keys(nowhere).length === 0, JSON.stringify(nowhere));
  }
} finally {
  rmSync(repo, { recursive: true, force: true });
}

done();

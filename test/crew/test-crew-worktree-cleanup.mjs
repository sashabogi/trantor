#!/usr/bin/env node
// #12269 seat cleanup drill — throwaway repos under a temp dir only: worktree removal at
// down (branch and commits kept, dirty trees kept and named), and a re-upped seat name
// reusing the freed worktree identity without losing unintegrated commits.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSeatWorktree, removeSeatWorktree } from "../../lib/seat-worktree.mjs";
import { down } from "../../bin/crew/state.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; process.stdout.write(`  ✓ ${name}\n`); }
  else { fail++; process.stdout.write(`  ✗ ${name}${detail ? " — " + detail : ""}\n`); }
};
const silent = () => {};

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return String(r.stdout || "").trim();
}

function makeRepo(base, name) {
  const repo = join(base, name);
  mkdirSync(repo, { recursive: true });
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "trantor@example.test"], repo);
  git(["config", "user.name", "Trantor Test"], repo);
  writeFileSync(join(repo, "README.md"), `${name}\n`);
  git(["add", "README.md"], repo);
  git(["commit", "-q", "-m", "init"], repo);
  return repo;
}

const root = mkdtempSync(join(tmpdir(), "trantor-seat-cleanup-"));

try {
  // ---- removeSeatWorktree ----
  console.log("\nremoveSeatWorktree: clean tree goes, branch and commits stay:");
  {
    const home = join(root, "home-rm");
    const repo = makeRepo(root, "repo-rm");
    const wt = ensureSeatWorktree({ sourceDir: repo, project: "proj", agent: "glm", home, log: silent });
    ok("worktree created", wt.created === true && wt.dir.includes(join(".agent-bus", "worktrees", "proj", "glm")));
    writeFileSync(join(wt.dir, "seat-work.txt"), "seat work\n");
    git(["add", "seat-work.txt"], wt.dir);
    git(["commit", "-q", "-m", "seat commit"], wt.dir);
    const seatSha = git(["rev-parse", "HEAD"], wt.dir);

    const r = removeSeatWorktree({ project: "proj", agent: "glm", home });
    ok("a clean worktree is removed", r.status === "removed", JSON.stringify(r));
    ok("the worktree directory is gone", !existsSync(wt.dir));
    ok("the branch survives the removal", git(["rev-parse", "refs/heads/seat/glm"], repo) === seatSha);
    ok("the seat commit survives on the branch", git(["log", "-1", "--format=%s", "seat/glm"], repo) === "seat commit");
  }

  console.log("\nremoveSeatWorktree: uncommitted changes keep the tree:");
  {
    const home = join(root, "home-dirty");
    const repo = makeRepo(root, "repo-dirty");
    const wt = ensureSeatWorktree({ sourceDir: repo, project: "proj", agent: "kimi", home, log: silent });
    writeFileSync(join(wt.dir, "wip.txt"), "half-done\n");
    const r = removeSeatWorktree({ project: "proj", agent: "kimi", home });
    ok("a dirty worktree is kept", r.status === "kept" && r.reason === "uncommitted changes", JSON.stringify(r));
    ok("the kept worktree is still on disk", existsSync(join(wt.dir, "wip.txt")));
    ok("a missing worktree answers absent", removeSeatWorktree({ project: "proj", agent: "ghost", home }).status === "absent");
    const guarded = removeSeatWorktree({ project: "proj", agent: "kimi", home, env: { CREW_NO_PROC_KILL: "1" } });
    ok("CREW_NO_PROC_KILL=1 guards removal", guarded.status === "kept");
    ok("dry answers would-remove without touching the tree",
      removeSeatWorktree({ project: "proj", agent: "kimi", home, dry: true }).status === "would-remove"
      && existsSync(join(wt.dir, "wip.txt")));
  }

  // ---- ensureSeatWorktree reuses the freed identity ----
  console.log("\na re-upped seat name reuses the freed worktree with its commits:");
  {
    const home = join(root, "home-reuse");
    const repo = makeRepo(root, "repo-reuse");
    const first = ensureSeatWorktree({ sourceDir: repo, project: "proj", agent: "codex", home, log: silent });
    writeFileSync(join(first.dir, "unintegrated.txt"), "not on main yet\n");
    git(["add", "unintegrated.txt"], first.dir);
    git(["commit", "-q", "-m", "unintegrated seat commit"], first.dir);
    const seatSha = git(["rev-parse", "HEAD"], first.dir);
    removeSeatWorktree({ project: "proj", agent: "codex", home });

    // main moves on while the seat is gone
    writeFileSync(join(repo, "main-moved.txt"), "main moved\n");
    git(["add", "main-moved.txt"], repo);
    git(["commit", "-q", "-m", "main moved on"], repo);

    const second = ensureSeatWorktree({ sourceDir: repo, project: "proj", agent: "codex", home, log: silent });
    ok("the worktree is re-created", second.created === true && existsSync(second.dir));
    ok("the re-created worktree sits at the seat branch tip, commits kept",
      git(["rev-parse", "HEAD"], second.dir) === seatSha, git(["rev-parse", "HEAD"], second.dir));
    ok("the unintegrated file is right there in the reused worktree",
      existsSync(join(second.dir, "unintegrated.txt")));

    // the merged case: everything harvested → a fresh checkout at main HEAD is lossless
    git(["merge", "--no-edit", "-q", "seat/codex"], repo);
    const mainSha = git(["rev-parse", "HEAD"], repo);
    removeSeatWorktree({ project: "proj", agent: "codex", home });
    const third = ensureSeatWorktree({ sourceDir: repo, project: "proj", agent: "codex", home, log: silent });
    ok("a fully harvested branch is re-created at main HEAD",
      third.created === true && git(["rev-parse", "HEAD"], third.dir) === mainSha);
  }

  // ---- down() removes worktrees via the seam ----
  console.log("\ndown() removes each stopped seat's worktree and names kept ones:");
  {
    const home = join(root, "home-down");
    const statePath = join(root, "crew-windows-down.txt");
    const ctx = { project: "fixture", statePath, env: { CREW_NO_PROC_KILL: "1" }, dry: false, home };
    const adapters = { herdr: { closePane: () => {}, closeWorkspace: () => {} } };
    const unregister = async (_ctx, project, persona) => ({ removed: true });
    writeFileSync(statePath, "fixture\therdr\tglm\tp1\nfixture\therdr\tcodex\tp2\n");

    const seen = [];
    const lines = [];
    const realLog = console.log;
    console.log = (l) => lines.push(l);
    try {
      await down(ctx, ["glm"], adapters, {
        unregister,
        removeWorktree: ({ project, agent }) => { seen.push(`${agent}:${project}`); return { status: "removed", path: `/wt/${project}/${agent}` }; },
      });
      ok("down removes the named seat's worktree", seen.join(",") === "glm:fixture", JSON.stringify(seen));
      ok("the removal is named in the output", lines.some((l) => l.includes("worktree removed") && l.includes("seat/glm kept")), lines.join(" | "));

      seen.length = 0; lines.length = 0;
      await down(ctx, [], adapters, {
        unregister,
        removeWorktree: ({ project, agent }) => {
          seen.push(`${agent}:${project}`);
          return agent === "codex"
            ? { status: "kept", path: `/wt/${project}/${agent}`, reason: "uncommitted changes" }
            : { status: "removed", path: `/wt/${project}/${agent}` };
        },
      });
      ok("whole-crew down removes the remaining seat's worktree", seen.join(",") === "codex:fixture", JSON.stringify(seen));
      ok("a kept worktree is named with its reason", lines.some((l) => l.includes("worktree kept (uncommitted changes)") && l.includes("/wt/fixture/codex")), lines.join(" | "));

      seen.length = 0; lines.length = 0;
      await down({ ...ctx, dry: true }, ["glm"], adapters, {
        unregister,
        removeWorktree: ({ project, agent, dry }) => { seen.push(`${agent}:${project}:dry=${dry}`); return { status: "would-remove", path: `/wt/${project}/${agent}` }; },
      });
      ok("dry down passes dry through the seam", seen.join(",") === "glm:fixture:dry=true", JSON.stringify(seen));
      ok("dry prints the would-remove line", lines.some((l) => l.includes("[dry] would remove worktree")), lines.join(" | "));

      seen.length = 0; lines.length = 0;
      await down(ctx, ["glm"], adapters, {
        unregister, processes: () => [123],
        removeWorktree: () => { seen.push("removed"); },
      });
      ok("a surviving process prevents removal after Stop", seen.length === 0
        && lines.some(line => line.includes("crew row or process remains")));

      seen.length = 0; lines.length = 0;
      await down(ctx, ["glm"], adapters, {
        unregister: async () => { writeFileSync(statePath, "fixture\therdr\tglm\tnew-pane\n"); return { removed: true }; },
        processes: () => [], removeWorktree: () => { seen.push("removed"); },
      });
      ok("a seat re-registered during Stop keeps its worktree", seen.length === 0
        && lines.some(line => line.includes("crew row or process remains")));
    } finally {
      console.log = realLog;
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? "✅" : "❌"} seat cleanup: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
// trantor crew worktree drill — every seat should do its edits in an isolated git worktree.
//
// The runner owns this, not crew.sh: the bus identity and project are resolved from the
// orchestrator's source dir, while each CLI turn runs from ~/.agent-bus/worktrees/<project>/<agent>.
// This drill drives the REAL runner with a fake hub and fake codex binary.
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? `\n        ${extra}` : ""}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const real = (p) => realpathSync(p);

console.log("# trantor crew worktree drill");

const hub = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (u.pathname === "/inbox") return reply({ messages: [], cursor: 0 });
    if (u.pathname === "/lessons") return reply({ lessons: [] });
    if (u.pathname === "/poll") return setTimeout(() => reply({ messages: [], cursor: 0 }), 150);
    return reply({ ok: true, peers: [], messages: [], cursor: 0 });
  });
});
await new Promise(r => hub.listen(0, "127.0.0.1", r));
const HUB = `http://127.0.0.1:${hub.address().port}`;

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return String(r.stdout || "").trim();
}

function makeRepo(base, name) {
  const repo = join(base, name);
  mkdirSync(repo, { recursive: true });
  git(["init", "-q"], repo);
  git(["config", "user.email", "trantor@example.test"], repo);
  git(["config", "user.name", "Trantor Test"], repo);
  writeFileSync(join(repo, "README.md"), `${name}\n`);
  git(["add", "README.md"], repo);
  git(["commit", "-q", "-m", "init"], repo);
  return repo;
}

async function runRunner({ sourceDir, project, home, noWorktree = false }) {
  const fakebin = join(home, "bin");
  const bus = join(home, ".agent-bus");
  mkdirSync(fakebin, { recursive: true });
  mkdirSync(bus, { recursive: true });
  const log = join(home, `${project}.log`);
  writeFileSync(join(fakebin, "codex"), `#!/bin/sh\npwd >> ${JSON.stringify(log)}\nexit 0\n`);
  chmodSync(join(fakebin, "codex"), 0o755);

  const env = { ...process.env, HOME: home, PATH: `${fakebin}:${process.env.PATH}`,
    RELAY_URL: HUB, RELAY_PROJECT: project, CREW_KICKOFF: "record cwd and stop" };
  if (noWorktree) env.TRANTOR_NO_WORKTREE = "1";
  const runner = spawn(process.execPath, ["bin/crew-runner.mjs", "codex", sourceDir], {
    cwd: process.cwd(), stdio: "ignore",
    env,
  });
  for (let i = 0; i < 80 && !read(log).trim(); i++) await sleep(100);
  runner.kill("SIGKILL");
  await sleep(100);
  return read(log).trim().split("\n").filter(Boolean);
}

const root = mkdtempSync(join(tmpdir(), "trantor-worktree-"));

console.log("\nA git-backed seat runs from its own worktree:");
{
  const home = join(root, "home-a");
  const repo = makeRepo(root, "repo-a");
  const project = "wt-a";
  const seatDir = join(home, ".agent-bus", "worktrees", project, "codex");
  const turns = await runRunner({ sourceDir: repo, project, home });
  ok("the first turn ran", turns.length >= 1, `turns=${JSON.stringify(turns)}`);
  ok("the first turn cwd is the seat worktree", real(turns[0]) === real(seatDir), `cwd=${turns[0]} expected=${seatDir}`);
  ok("the worktree was created on the seat branch",
    git(["-C", seatDir, "branch", "--show-current"], seatDir) === "seat/codex");

  writeFileSync(join(seatDir, "reuse-marker.txt"), "still here\n");
  const second = await runRunner({ sourceDir: repo, project, home });
  ok("a second boot reuses the same worktree", real(second[0]) === real(seatDir), `cwd=${second[0]} expected=${seatDir}`);
  ok("reuse does not replace the existing worktree", existsSync(join(seatDir, "reuse-marker.txt")));
}

console.log("\nWorktree creation carries Orca's memory (--no-track, push.autoSetupRemote, branch.<b>.base):");
{
  const home = join(root, "home-d");
  const repo = makeRepo(root, "repo-d");
  const project = "wt-memory";
  const seatDir = join(home, ".agent-bus", "worktrees", project, "codex");
  const branch = "seat/codex";

  // Set up a remote tracking branch so the base ff has something to fast-forward to
  const defaultBranch = git(["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], repo);
  git(["-C", repo, "config", "user.email", "trantor@example.test"], repo);
  git(["-C", repo, "config", "user.name", "Trantor Test"], repo);
  writeFileSync(join(repo, "new-file.txt"), "new content\n");
  git(["-C", repo, "add", "new-file.txt"], repo);
  git(["-C", repo, "commit", "-q", "-m", "second commit"], repo);

  const turns = await runRunner({ sourceDir: repo, project, home });
  ok("the first turn ran", turns.length >= 1, `turns=${JSON.stringify(turns)}`);

  // --no-track: the seat branch should have no upstream configured
  let upstream;
  try { upstream = git(["-C", seatDir, "rev-parse", "--abbrev-ref", `${branch}@{upstream}`], seatDir); } catch { upstream = ""; }
  ok("--no-track: no upstream on the seat branch", upstream === "", `upstream=${upstream || "(none)"}`);

  // push.autoSetupRemote should be set to true
  const pushAuto = git(["-C", seatDir, "config", "--get", "push.autoSetupRemote"], seatDir);
  ok("push.autoSetupRemote is set to true", pushAuto === "true", `push.autoSetupRemote=${pushAuto || "(unset)"}`);

  // branch.<branch>.base should be persisted
  const branchBase = git(["-C", seatDir, "config", "--get", `branch.${branch}.base`], seatDir);
  ok("branch.<b>.base is persisted", branchBase === defaultBranch, `branch.base=${branchBase || "(unset)"}`);
}

console.log("\nNon-git and explicit opt-out seats are left alone:");
{
  const home = join(root, "home-b");
  const sourceDir = join(root, "not-a-repo");
  mkdirSync(sourceDir, { recursive: true });
  const project = "wt-nongit";
  const turns = await runRunner({ sourceDir, project, home });
  ok("non-git source dirs run in the original cwd", real(turns[0]) === real(sourceDir), `cwd=${turns[0]} expected=${sourceDir}`);
  ok("non-git source dirs do not get a worktree", !existsSync(join(home, ".agent-bus", "worktrees", project, "codex")));
}

{
  const home = join(root, "home-c");
  const repo = makeRepo(root, "repo-c");
  const project = "wt-optout";
  const turns = await runRunner({ sourceDir: repo, project, home, noWorktree: true });
  ok("TRANTOR_NO_WORKTREE=1 keeps the original cwd", real(turns[0]) === real(repo), `cwd=${turns[0]} expected=${repo}`);
  ok("TRANTOR_NO_WORKTREE=1 does not create a worktree", !existsSync(join(home, ".agent-bus", "worktrees", project, "codex")));
}

hub.close();
console.log(`\n${fail === 0 ? "✅" : "❌"} crew worktree: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

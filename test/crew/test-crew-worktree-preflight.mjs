#!/usr/bin/env node
// trantor worktree preflight drill (#7760): a project with a relative sibling package and a
// gitignored required file is provisioned into the seat worktree and preflights with both named.
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { drillEnv, scrubIdentityEnv } from "../drill-env.mjs";
import { preflightFirstSeat } from "../../bin/crew/preflight.mjs";
import { readWorktreeDeclaration, seatWorktreeDir } from "../../lib/seat-worktree.mjs";

scrubIdentityEnv();
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? `\n        ${extra}` : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const real = (p) => { try { return realpathSync(p); } catch { return ""; } };

console.log("# trantor worktree preflight drill (#7760)");

const sends = [];
const hub = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (u.pathname === "/send") { try { sends.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch {} return reply({ ok: true, id: sends.length }); }
    if (u.pathname === "/inbox") return reply({ messages: [], cursor: 0 });
    if (u.pathname === "/lessons") return reply({ lessons: [] });
    if (u.pathname === "/poll") return setTimeout(() => reply({ messages: [], cursor: 0 }), 150);
    return reply({ ok: true, peers: [], messages: [], cursor: 0 });
  });
});
await new Promise((r) => hub.listen(0, "127.0.0.1", r));
const HUB = `http://127.0.0.1:${hub.address().port}`;

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return String(r.stdout || "").trim();
}

const PREFLIGHT_SH = `#!/bin/sh
rc=0
[ -e ../SIB/pkg.txt ] || { echo "missing sibling ../SIB/pkg.txt"; rc=1; }
[ -e config/secret.txt ] || { echo "missing config/secret.txt"; rc=1; }
[ $rc = 0 ] && echo "build fine"
exit $rc
`;

// A fixture project: sibling package at ../<sib>, gitignored config/secret.txt, a stubbed env file,
// an operator-only file, and a preflight that names whatever is missing.
function makeProject(base, name, { sib, withSibling = true, withSecret = true, preflight = "sh preflight.sh" }) {
  const repo = join(base, name);
  mkdirSync(join(repo, ".trantor"), { recursive: true });
  mkdirSync(join(repo, "config"), { recursive: true });
  git(["init", "-q"], repo);
  git(["config", "user.email", "trantor@example.test"], repo);
  git(["config", "user.name", "Trantor Test"], repo);
  writeFileSync(join(repo, "README.md"), `${name}\n`);
  writeFileSync(join(repo, ".gitignore"), "config/secret.txt\nconfig/local.env\nios/Real.swift\n");
  writeFileSync(join(repo, "preflight.sh"), PREFLIGHT_SH.replaceAll("SIB", sib));
  writeFileSync(join(repo, "config", "local.env.example"), "KEY=example\n");
  writeFileSync(join(repo, ".trantor", "worktree.json"), JSON.stringify({
    link: [`../${sib}`],
    provision: [
      { path: "config/secret.txt", mode: "link" },
      { path: "config/local.env", mode: "stub", template: "config/local.env.example" },
      { path: "ios/Real.swift", mode: "operator" },
    ],
    preflight,
  }, null, 2));
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "init"], repo);
  if (withSecret) writeFileSync(join(repo, "config", "secret.txt"), "real-secret\n");
  if (withSibling) { mkdirSync(join(base, sib), { recursive: true }); writeFileSync(join(base, sib, "pkg.txt"), "package\n"); }
  return repo;
}

function ctxFor(repo, project, home) {
  const bus = join(home, ".agent-bus");
  mkdirSync(bus, { recursive: true });
  process.env.AGENT_BUS_DIR = bus;
  return { dir: repo, project, home, hub: HUB, dry: false,
    env: drillEnv({ HOME: home, AGENT_BUS_DIR: bus, RELAY_SESSION: `orch:${project}`, RELAY_PROJECT: project }) };
}

const root = mkdtempSync(join(tmpdir(), "trantor-preflight-"));

console.log("\nThe declaration parses:");
{
  const repo = makeProject(join(root, "parse"), "app", { sib: "app-sib" });
  const decl = readWorktreeDeclaration(repo);
  ok("link, provision and preflight are read", decl && decl.link.length === 1 && decl.provision.length === 3 && decl.preflight === "sh preflight.sh", JSON.stringify(decl));
  ok("a project without .trantor/worktree.json declares nothing", readWorktreeDeclaration(join(root, "parse", "app-sib")) === null);
}

console.log("\n`trantor up` provisions the first seat worktree and preflights ok:");
{
  const base = join(root, "good");
  const repo = makeProject(base, "app", { sib: "app-sib" });
  const home = join(root, "home-good");
  const ctx = ctxFor(repo, "pf-good", home);
  const lines = [];
  const before = sends.length;
  const r = await preflightFirstSeat(ctx, "codex", { capMs: 60_000, log: (l) => lines.push(String(l)) });
  const seatDir = seatWorktreeDir("pf-good", "codex", home);
  ok("the first seat worktree was created by up", r.created === true && existsSync(join(seatDir, "README.md")), JSON.stringify(r).slice(0, 300));
  const sibLink = resolve(seatDir, "../app-sib");
  ok("the sibling is symlinked beside the worktree where the relative path resolves",
    isLink(sibLink) && real(sibLink) === real(join(base, "app-sib")), `at=${sibLink} -> ${real(sibLink)}`);
  const secret = join(seatDir, "config", "secret.txt");
  ok("the gitignored file is LINKED to the main checkout, not copied",
    isLink(secret) && real(secret) === real(join(repo, "config", "secret.txt")) && read(secret) === "real-secret\n", `link=${isLink(secret)} target=${real(secret)}`);
  ok("a stub is written from its template", read(join(seatDir, "config", "local.env")) === "KEY=example\n" && !isLink(join(seatDir, "config", "local.env")));
  ok("an operator file is not created", !existsSync(join(seatDir, "ios", "Real.swift")));
  ok("the operator step is named in the up output", lines.some((l) => /OPERATOR ios\/Real\.swift/.test(l)), lines.join("\n"));
  ok("the worktree stays clean after provisioning", git(["status", "--porcelain"], seatDir) === "", git(["status", "--porcelain"], seatDir));
  ok("preflight ok is printed", r.result?.ok === true && lines.some((l) => /preflight ok \(sh preflight\.sh/.test(l)), lines.join("\n"));
  ok("no problems were reported", r.applied.problems.length === 0, r.applied.problems.join("; "));
  const post = sends[before];
  ok("the result is broadcast on the bus as a status", r.posted === true && post && post.to === "all" && post.kind === "status" && post.project === "pf-good" && post.from === "orch:pf-good", JSON.stringify(post));
  ok("the broadcast starts with preflight ok and names the operator step", /^preflight ok/.test(post?.text || "") && /ios\/Real\.swift/.test(post?.text || ""), post?.text);

  const again = [];
  const r2 = await preflightFirstSeat(ctx, "codex", { capMs: 60_000, log: (l) => again.push(String(l)) });
  ok("a second up reuses the worktree and re-applies without problems", r2.created === false && r2.applied.problems.length === 0 && r2.result?.ok === true, again.join("\n"));
  ok("re-applying keeps the existing links", isLink(secret) && isLink(sibLink));
}

console.log("\nA missing sibling and a missing gitignored file preflight with BOTH named:");
{
  const base = join(root, "bad");
  const repo = makeProject(base, "app", { sib: "app-sib", withSibling: false, withSecret: false });
  const home = join(root, "home-bad");
  const ctx = ctxFor(repo, "pf-bad", home);
  const lines = [];
  const before = sends.length;
  const r = await preflightFirstSeat(ctx, "codex", { capMs: 60_000, log: (l) => lines.push(String(l)) });
  ok("preflight failed", r.result?.ok === false, JSON.stringify(r.result));
  const failLine = lines.find((l) => /preflight failed:/.test(l)) || "";
  ok("the failure names the sibling package", /missing sibling \.\.\/app-sib\/pkg\.txt/.test(failLine), failLine);
  ok("the failure names the gitignored file", /missing config\/secret\.txt/.test(failLine), failLine);
  ok("provisioning names the missing sibling checkout", r.applied.problems.some((p) => /link \.\.\/app-sib: sibling checkout missing/.test(p)), r.applied.problems.join("; "));
  ok("provisioning names the missing real file instead of inventing one", r.applied.problems.some((p) => /provision config\/secret\.txt: mode link but .* is missing/.test(p)) && !existsSync(join(seatWorktreeDir("pf-bad", "codex", home), "config", "secret.txt")), r.applied.problems.join("; "));
  const post = sends[before];
  ok("the failure is broadcast with both names", /^preflight failed/.test(post?.text || "") && /app-sib/.test(post?.text || "") && /secret\.txt/.test(post?.text || ""), post?.text);
}

console.log("\nThe preflight is capped:");
{
  const base = join(root, "slow");
  const repo = makeProject(base, "app", { sib: "app-sib", preflight: "sleep 30" });
  const ctx = ctxFor(repo, "pf-slow", join(root, "home-slow"));
  const lines = [];
  const t0 = Date.now();
  const r = await preflightFirstSeat(ctx, "codex", { capMs: 800, log: (l) => lines.push(String(l)) });
  ok("a preflight over the cap is killed and reported failed", r.result?.ok === false && r.result?.timedOut === true && Date.now() - t0 < 10_000, JSON.stringify(r.result));
  ok("the cap is named in the output", lines.some((l) => /preflight killed after 1s cap/.test(l)), lines.join("\n"));
}

console.log("\nNo declaration means no preflight and no worktree from up (unchanged behaviour):");
{
  const repo = join(root, "plain", "app");
  mkdirSync(repo, { recursive: true });
  git(["init", "-q"], repo);
  git(["config", "user.email", "trantor@example.test"], repo);
  git(["config", "user.name", "Trantor Test"], repo);
  writeFileSync(join(repo, "README.md"), "plain\n");
  git(["add", "README.md"], repo);
  git(["commit", "-q", "-m", "init"], repo);
  const home = join(root, "home-plain");
  const before = sends.length;
  const r = await preflightFirstSeat(ctxFor(repo, "pf-plain", home), "codex", { log: () => {} });
  ok("up skips silently", r.skipped === "no declaration");
  ok("no worktree is created and nothing is posted", !existsSync(seatWorktreeDir("pf-plain", "codex", home)) && sends.length === before);
}

console.log("\nThe runner provisions a fresh seat worktree the same way:");
{
  const base = join(root, "runner");
  const repo = makeProject(base, "app", { sib: "app-sib" });
  const home = join(root, "home-runner");
  const fakebin = join(home, "bin");
  mkdirSync(fakebin, { recursive: true });
  mkdirSync(join(home, ".agent-bus"), { recursive: true });
  const log = join(home, "turns.log");
  writeFileSync(join(fakebin, "codex"), `#!/bin/sh\npwd >> ${JSON.stringify(log)}\nexit 0\n`);
  chmodSync(join(fakebin, "codex"), 0o755);
  const env = drillEnv({ HOME: home, PATH: `${fakebin}:${process.env.PATH}`, RELAY_URL: HUB, RELAY_PROJECT: "pf-runner", CREW_KICKOFF: "record cwd and stop" });
  delete env.AGENT_BUS_DIR;
  const runner = spawn(process.execPath, ["bin/crew-runner.mjs", "codex", repo], { cwd: process.cwd(), stdio: "ignore", env });
  for (let i = 0; i < 100 && !read(log).trim(); i++) await sleep(100);
  runner.kill("SIGKILL");
  await sleep(100);
  const seatDir = seatWorktreeDir("pf-runner", "codex", home);
  ok("the turn ran in the seat worktree", real(read(log).trim().split("\n")[0] || "") === real(seatDir), read(log));
  ok("the runner linked the sibling beside the worktree", isLink(resolve(seatDir, "../app-sib")) && existsSync(resolve(seatDir, "../app-sib/pkg.txt")));
  ok("the runner linked the gitignored file (no copy)", isLink(join(seatDir, "config", "secret.txt")) && real(readlinkSync(join(seatDir, "config", "secret.txt"))) === real(join(repo, "config", "secret.txt")));
  ok("the runner stubbed the env file", read(join(seatDir, "config", "local.env")) === "KEY=example\n");
}

hub.close();
console.log(`\n${fail === 0 ? "✅" : "❌"} worktree preflight: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

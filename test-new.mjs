#!/usr/bin/env node
// Project genesis drill (#5862): `trantor new` in all three start-from modes — plain init,
// clone --from, and --adopt — against a REAL throwaway hub, plus the guarded refusals (occupied
// dir without --adopt, missing brief file). Asserts the DIRECTORY facts (git branch, CLAUDE.md
// seeding, hook install), the HUB facts (brief posted, "genesis:" card on the new board), and
// the --json contract ({name, dir, branch, hub, card}).
import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log("# trantor new — project genesis drill");

const W = mkdtempSync(join(tmpdir(), "trantor-new-"));
const DEV = join(W, "dev");
mkdirSync(DEV, { recursive: true });
mkdirSync(join(W, ".agent-bus"), { recursive: true });
writeFileSync(join(W, ".agent-bus", "autonomy.json"), JSON.stringify({
  version: 1,
  defaults: { harness: "bypass" },
  projects: { inherited: { harness: "bypass" } },
}));
const PORT = 47877, HUB = `http://127.0.0.1:${PORT}`;

const hub = spawn("node", [join(ROOT, "hub.mjs")], {
  env: { ...process.env, RELAY_DATA_DIR: W, HOME: W, RELAY_PORT: String(PORT), PORT: String(PORT), TRANTOR_NO_UPDATE_CHECK: "1" },
  stdio: ["ignore", "ignore", "pipe"],
});
hub._stderr = "";
hub.stderr.on("data", d => { hub._stderr += String(d); });
let hubUp = false;
for (let i = 0; i < 50; i++) {
  if (hub.exitCode !== null) { console.error("hub exited early:", hub._stderr); process.exit(1); }
  try { const r = await fetch(`${HUB}/health`); if (r.ok) { hubUp = true; break; } } catch {}
  await sleep(100);
}
ok("throwaway hub is up", hubUp);

const childEnv = (extra = {}) => ({
  ...process.env, HOME: W, AGENT_BUS_DIR: join(W, ".agent-bus"),
  RELAY_URL: HUB, TRANTOR_DEV_ROOT: DEV, RELAY_SESSION: "genesis-test",
  TRANTOR_NO_UPDATE_CHECK: "1", ...extra,
});
const runNew = (args, env = {}) => spawnSync("node", [join(ROOT, "bin", "new.mjs"), ...args], {
  encoding: "utf8", cwd: W, env: childEnv(env),
});

const BRIEF = "Genesis drill project: prove `trantor new` stands a project up in one command.";
const briefFile = join(W, "brief.md");
writeFileSync(briefFile, BRIEF);

// ── mode 1: plain init ──────────────────────────────────────────────────────────────────────────
const a = runNew(["genesis-a", "--brief", briefFile, "--json"]);
ok("init: exit 0", a.status === 0, `status ${a.status}: ${a.stderr.slice(-200)}`);
let aJson = null;
try { aJson = JSON.parse(a.stdout); } catch {}
ok("init: --json shape", !!aJson && aJson.name === "genesis-a" && aJson.branch === "main" && aJson.dir === join(DEV, "genesis-a") && Number.isInteger(aJson.card), JSON.stringify(aJson));
ok("init: hub in json is the test hub", !!aJson && aJson.hub === HUB);
ok("init: CLAUDE.md carries the brief verbatim", existsSync(aJson.dir) && readFileSync(join(aJson.dir, "CLAUDE.md"), "utf8").includes(BRIEF));
ok("init: CLAUDE.md carries the conventions block", readFileSync(join(aJson.dir, "CLAUDE.md"), "utf8").includes("## Trantor conventions"));
ok("init: auto-card hook installed", readFileSync(join(aJson.dir, ".git", "hooks", "post-commit"), "utf8").includes("trantor auto-card"));
ok("init: git branch is main", aJson?.branch === "main");
const autonomy = JSON.parse(readFileSync(join(W, ".agent-bus", "autonomy.json"), "utf8"));
ok("init: fresh project pins its harness dial to prompt", autonomy.projects?.["genesis-a"]?.harness === "prompt");
ok("init: another project's bypass dial stays untouched", autonomy.projects?.inherited?.harness === "bypass");

const tasksA = await (await fetch(`${HUB}/tasks?project=genesis-a`)).json();
const cardA = (tasksA.tasks ?? []).find(t => t.title === "genesis: genesis-a");
ok("init: genesis card on the new board", !!cardA, JSON.stringify(tasksA).slice(0, 200));
const projectsA = await (await fetch(`${HUB}/projects`)).json();
ok("init: brief posted to the hub", JSON.stringify(projectsA).includes("Genesis drill project"));

// ── mode 2: clone --from ────────────────────────────────────────────────────────────────────────
const src = join(W, "src-repo");
mkdirSync(src, { recursive: true });
writeFileSync(join(src, "seed.txt"), "cloned seed\n");
const git = (args) => spawnSync("git", args, { cwd: src, encoding: "utf8" });
git(["init", "-b", "main"]);
git(["add", "."]);
git(["-c", "user.email=drill@trantor", "-c", "user.name=drill", "commit", "-m", "seed"]);
const b = runNew(["genesis-b", "--from", src, "--json"]);
ok("clone: exit 0", b.status === 0, `status ${b.status}: ${b.stderr.slice(-200)}`);
let bJson = null;
try { bJson = JSON.parse(b.stdout); } catch {}
ok("clone: dir carries the cloned file", !!bJson && readFileSync(join(bJson.dir, "seed.txt"), "utf8").includes("cloned seed"));
ok("clone: branch is the clone's main", bJson?.branch === "main");
ok("clone: hook + CLAUDE.md still land", !!bJson && readFileSync(join(bJson.dir, "CLAUDE.md"), "utf8").includes("## Trantor conventions") && readFileSync(join(bJson.dir, ".git", "hooks", "post-commit"), "utf8").includes("trantor auto-card"));

// ── mode 3: --adopt ─────────────────────────────────────────────────────────────────────────────
const adoptDir = join(DEV, "genesis-c");
mkdirSync(adoptDir, { recursive: true });
writeFileSync(join(adoptDir, "existing.txt"), "operator work\n");
const c = runNew(["genesis-c", "--adopt", "--json"]);
ok("adopt: exit 0", c.status === 0, `status ${c.status}: ${c.stderr.slice(-200)}`);
ok("adopt: operator file untouched", existsSync(join(adoptDir, "existing.txt")));
ok("adopt: conventions appended, existing CLAUDE.md respected", existsSync(join(adoptDir, "CLAUDE.md")) === false || readFileSync(join(adoptDir, "CLAUDE.md"), "utf8").includes("## Trantor conventions"));

// ── refusals ────────────────────────────────────────────────────────────────────────────────────
const r1 = runNew(["genesis-c"]);
ok("refusal: occupied dir without --adopt exits non-zero", r1.status !== 0);
ok("refusal: the error names the directory and the way out", (r1.stderr || "").includes("--adopt"));

const r2 = runNew(["genesis-d", "--brief", join(W, "no-such-brief.md")]);
ok("refusal: missing brief file exits non-zero", r2.status !== 0);
ok("refusal: nothing was created for the refused run", !existsSync(join(DEV, "genesis-d")));

hub.kill();
try { rmSync(W, { recursive: true, force: true }); } catch {}

console.log(`\n${fail === 0 ? "✅" : "❌"} new: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

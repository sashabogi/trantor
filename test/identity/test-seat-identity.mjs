#!/usr/bin/env node
// trantor — a session must KNOW whether it is a seat, and a hub must never be chosen silently
// (the reboot-into-$HOME phantom seats, #6108). Drilled against the REAL hook: a non-seat does not
// register and is TOLD; an unpinned seat registers but is warned; a pinned one lands on its hub
// silently. Run against an older tree with TRANTOR_ROOT=<path> to prove these fail before the fix.
import http from "node:http";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv, scrubIdentityEnv } from "../drill-env.mjs";

const ROOT = process.env.TRANTOR_ROOT || fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
// Pin the drill's OWN env (#6108): section 5 asserts nonSeatReason() as a pure unit, but the
// function defaults env=process.env — a runner exporting RELAY_PROJECT/RELAY_SESSION would flip
// "home is a non-seat" into a seat. The host's identity env is the runner's, never the drill's.
scrubIdentityEnv();
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };

console.log(`# trantor seat-identity drill${process.env.TRANTOR_ROOT ? ` (root: ${ROOT})` : ""}`);

// ── recorder hubs: "pinned" is where a pinned project must land, "fallback" is the global default
const hits = { pinned: [], fallback: [] };
function recorder(which) {
  return http.createServer((req, res) => {
    let b = ""; req.on("data", c => (b += c));
    req.on("end", () => {
      let body = {}; try { body = JSON.parse(b || "{}"); } catch {}
      hits[which].push({ path: req.url, method: req.method, project: body.project, session: body.session });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, peers: [], grants: [], tasks: [], messages: [], cursor: 0, total: 0 }));
    });
  });
}
const P = recorder("pinned"), F = recorder("fallback");
await new Promise(r => P.listen(0, "127.0.0.1", r));
await new Promise(r => F.listen(0, "127.0.0.1", r));
const PINNED = `http://127.0.0.1:${P.address().port}`, FALLBACK = `http://127.0.0.1:${F.address().port}`;

const W = mkdtempSync(join(tmpdir(), "trantor-seat-"));
const BUS = join(W, "bus"); mkdirSync(BUS, { recursive: true });
writeFileSync(join(BUS, "config.json"), JSON.stringify({ url: FALLBACK, hubs: { "pinned-proj": PINNED } }));

// two real git repos: one pinned by name, one not
function repo(name) {
  const d = join(W, name); mkdirSync(d, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: d });
  return d;
}
const pinnedRepo = repo("pinned-proj");
const unpinnedRepo = repo("unpinned-proj");
const plainDir = join(W, "not-a-repo"); mkdirSync(plainDir, { recursive: true });
// a workspace CONTAINER: ~/development — not a repo, but full of them
const container = join(W, "workspace"); mkdirSync(container, { recursive: true });
for (const r of ["alpha", "beta"]) { const d = join(container, r); mkdirSync(d, { recursive: true }); spawnSync("git", ["init", "-q"], { cwd: d }); }
// #6842 — a WRAPPER: a leftover workspace folder holding the real project (a repo with a
// CLAUDE.md) beside two stray repos and a .tmp, the witnessed builtbetter.ai shape.
const wrapper = join(W, "builtbetter.ai"); mkdirSync(wrapper, { recursive: true });
for (const r of ["builtbetter", "builtbetter-git", "builtbetter-worktree", ".tmp"]) { const d = join(wrapper, r); mkdirSync(d, { recursive: true }); spawnSync("git", ["init", "-q"], { cwd: d }); }
writeFileSync(join(wrapper, "builtbetter", "CLAUDE.md"), "# builtbetter\n");
const nestedReal = join(wrapper, "builtbetter");

let n = 0;
// The hook must run ASYNC (spawn, not spawnSync): the recorder hubs live in THIS process, so a
// synchronous child would block the event loop that has to answer its own requests — the hook
// would stall on every fetch and the drill would measure the harness, not the hook.
function runHook(cwd) {
  hits.pinned.length = 0; hits.fallback.length = 0;
  return new Promise((resolve) => {
    const kid = spawn(process.execPath, [join(ROOT, "hooks", "sessionstart.mjs")], {
      env: { ...drillEnv(), AGENT_BUS_DIR: BUS, TRANTOR_NO_UPDATE_CHECK: "1", TRANTOR_NO_BALANCE_CHECK: "1",
             RELAY_SESSION: "", RELAY_PROJECT: "", RELAY_URL: "", CLAUDE_PROJECT_DIR: cwd },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let so = "", se = "";
    kid.stdout.on("data", d => (so += d));
    kid.stderr.on("data", d => (se += d));
    const done = () => {
      let out = {}; try { out = JSON.parse(so || "{}"); } catch {}
      const regs = [...hits.pinned, ...hits.fallback].filter(h => h.path === "/register");
      resolve({
        ctx: out?.hookSpecificOutput?.additionalContext || "",
        sys: out?.systemMessage || "",
        registers: regs,
        onPinned: hits.pinned.filter(h => h.path === "/register").length,
        onFallback: hits.fallback.filter(h => h.path === "/register").length,
        stderr: se,
      });
    };
    kid.on("close", () => setTimeout(done, 150));   // let any in-flight recorder request land
    kid.stdin.end(JSON.stringify({ cwd, session_id: `seat-test-${++n}`, source: "startup" }));
    setTimeout(() => { try { kid.kill("SIGKILL"); } catch {} }, 20000).unref?.();
  });
}

console.log("\n1. The home directory is not a seat:");
{
  const r = await runHook(homedir());
  ok("does not register on any hub", r.registers.length === 0, `${r.registers.length} register(s)`);
  ok("the MODEL is told it is not a seat", /not-a-seat|NOT registered on Trantor/i.test(r.ctx), r.ctx.slice(0, 90));
  ok("the USER sees a terminal banner", /not a trantor seat/i.test(r.sys), r.sys.slice(0, 90));
  ok("names the fix (start from the project directory)", /cd <project>|project directory/i.test(r.ctx + r.sys));
  ok("pre-empts the wrong diagnosis", /unreachable|not the bus being down|hubs are almost certainly healthy/i.test(r.ctx));
}

console.log("\n2. A folder OF projects (~/development) is not a seat either:");
{
  const r = await runHook(container);
  ok("does not register", r.registers.length === 0, `${r.registers.length} register(s)`);
  ok("says why (a folder of projects)", /folder of projects/i.test(r.ctx + r.sys), r.sys.slice(0, 90));
}

console.log("\n2a. A wrapper dir names its nested project and the fix, not a wall of text (#6842):");
{
  const r = await runHook(wrapper);
  ok("does not register", r.registers.length === 0, `${r.registers.length} register(s)`);
  ok("the banner names the nested project", r.sys.includes(`Its project is builtbetter`), r.sys.slice(0, 160));
  ok("the banner names the in-place start", r.sys.includes(`cd ${nestedReal} && claude`), r.sys.slice(0, 160));
  ok("the banner names the promotion", r.sys.includes(`mv ${nestedReal} ${join(W, "builtbetter")}`), r.sys.slice(0, 200));
  ok("the strays are not offered", !/builtbetter-git|builtbetter-worktree/.test(r.sys + r.ctx));
  ok("the model is told the real project", /Its real project:\*\* builtbetter/.test(r.ctx), r.ctx.slice(0, 200));
}

console.log("\n2b. …but a plain directory with no repo IS still a seat (do not over-block):");
{
  const r = await runHook(plainDir);
  ok("registers normally", r.registers.length >= 1, `${r.registers.length} register(s)`);
  ok("no not-a-seat block", !/not-a-seat/.test(r.ctx));
}

console.log("\n3. A real repo with no hub pin registers, but is warned:");
{
  const r = await runHook(unpinnedRepo);
  ok("registers on the fallback hub", r.onFallback >= 1, `pinned=${r.onPinned} fallback=${r.onFallback}`);
  ok("model is warned the hub was a fallback", /hub-unpinned|no hub pin/i.test(r.ctx), r.ctx.slice(0, 90));
  ok("user is warned in-terminal", /not pinned to a hub/i.test(r.sys), r.sys.slice(0, 90));
  ok("names the pin command", /trantor hub set/.test(r.ctx + r.sys));
}

console.log("\n4. A pinned project routes to its hub, silently (no false alarm):");
{
  const r = await runHook(pinnedRepo);
  ok("registers on the PINNED hub", r.onPinned >= 1, `pinned=${r.onPinned} fallback=${r.onFallback}`);
  ok("never touches the fallback hub", r.onFallback === 0);
  ok("no unpinned warning", !/hub-unpinned/.test(r.ctx));
  ok("no not-a-seat warning", !/not-a-seat/.test(r.ctx));
}

console.log("\n4b. A drill must never touch the REAL bus directory:");
{
  // Regression: this very pre-flight, pointed at a temp AGENT_BUS_DIR, once claimed two live
  // handoffs because the READER joined homedir() while the WRITER honoured RELAY_DATA_DIR.
  const hoDir = join(BUS, "handoffs"); mkdirSync(hoDir, { recursive: true });
  const proj = "pinned-proj";
  writeFileSync(join(hoDir, `${proj}-1700000001.json`), JSON.stringify({
    id: `${proj}-1700000001`, projectName: proj, stamp: 1700000001,
    summary: "SENTINEL handoff — must come from the TEMP bus dir", consumed: false,
  }));
  const r = await runHook(pinnedRepo);
  ok("reads the handoff from AGENT_BUS_DIR", /SENTINEL handoff/.test(r.ctx), r.ctx.slice(0, 120));
  const after = JSON.parse(readFileSync(join(hoDir, `${proj}-1700000001.json`), "utf8"));
  ok("claims the TEMP copy", after.consumed === true);
  process.env.AGENT_BUS_DIR = BUS;   // the child already had it; the parent needs it to assert
  const m2 = await import(join(ROOT, "lib", "project.mjs"));
  ok("handoffDir() follows AGENT_BUS_DIR", m2.handoffDir?.() === hoDir, m2.handoffDir?.());
  const realDir = join(homedir(), ".agent-bus", "handoffs");
  ok("and is NOT the real ~/.agent-bus/handoffs", m2.handoffDir?.() !== realDir);
}

console.log("\n5. Hub provenance is part of the answer (unit):");
{
  process.env.AGENT_BUS_DIR = BUS;
  delete process.env.RELAY_URL;
  const m = await import(join(ROOT, "lib", "project.mjs"));
  ok("pinned project reports via=pin", m.resolveHubInfo?.("pinned-proj")?.via === "pin");
  ok("unpinned project reports via=global", m.resolveHubInfo?.("nope")?.via === "global");
  ok("RELAY_URL reports via=env", m.resolveHubInfo?.("pinned-proj", { RELAY_URL: "http://x:1" })?.via === "env");
  ok("home is classified a non-seat", m.nonSeatReason?.(homedir()) === "the home directory");
  ok("a repo container is classified a non-seat", /folder of projects/.test(m.nonSeatReason?.(container) || ""));
  ok("a plain non-git dir is still a seat", m.nonSeatReason?.(plainDir) === "");
  ok("a git repo is a seat", m.nonSeatReason?.(pinnedRepo) === "");
  ok("a wrapper is classified a non-seat", /folder of projects/.test(m.nonSeatReason?.(wrapper) || ""));
  ok("the nested project is the CLAUDE.md repo, never the strays", JSON.stringify(m.nestedProjects?.(wrapper)) === JSON.stringify([nestedReal]), JSON.stringify(m.nestedProjects?.(wrapper)));
  ok("a container without a CLAUDE.md repo has no nested project", (m.nestedProjects?.(container) || []).length === 0);
  ok("a plain repo has no nested project", (m.nestedProjects?.(pinnedRepo) || []).length === 0);
  ok("known projects are listable", Array.isArray(m.knownProjects?.()) && m.knownProjects().includes("pinned-proj"));
}

P.close(); F.close();
try { rmSync(W, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? "✅" : "❌"} seat-identity: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

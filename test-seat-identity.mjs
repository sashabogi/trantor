#!/usr/bin/env node
// trantor — a session must KNOW whether it is a seat, and a hub must never be chosen silently.
//
// The bug this pins (2026-08-23): a macOS reboot reopened every Terminal window in $HOME.
// `claude --resume` restored each conversation but not its directory, so the crebral-health and
// crebral-scribe windows came back as home-directory sessions. The SessionStart hook correctly
// declined to register them — and said so ONLY on stderr, which nobody reads. Each session spent
// an hour believing it was its old seat and finally reported "Trantor is unreachable" while every
// hub was healthy. Meanwhile relay_whoami POSTed /register before answering, so the act of asking
// "where am I?" minted the phantom seat it then reported, on the local fallback hub.
//
// Three invariants, drilled against the REAL hook:
//   1. A non-seat directory does not register — and the session is TOLD, in context and on screen.
//   2. A seat whose project has no hub pin registers, but is warned that its hub was a fallback.
//   3. A pinned project registers on its pinned hub with no warning at all.
//
// Run against an older tree with TRANTOR_ROOT=<path> to prove these fail before the fix.
import http from "node:http";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.TRANTOR_ROOT || dirname(fileURLToPath(import.meta.url));
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

let n = 0;
// The hook must run ASYNC (spawn, not spawnSync): the recorder hubs live in THIS process, so a
// synchronous child would block the event loop that has to answer its own requests — the hook
// would stall on every fetch and the drill would measure the harness, not the hook.
function runHook(cwd) {
  hits.pinned.length = 0; hits.fallback.length = 0;
  return new Promise((resolve) => {
    const kid = spawn(process.execPath, [join(ROOT, "hooks", "sessionstart.mjs")], {
      env: { ...process.env, AGENT_BUS_DIR: BUS, TRANTOR_NO_UPDATE_CHECK: "1", TRANTOR_NO_BALANCE_CHECK: "1",
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
  ok("known projects are listable", Array.isArray(m.knownProjects?.()) && m.knownProjects().includes("pinned-proj"));
}

P.close(); F.close();
try { rmSync(W, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? "✅" : "❌"} seat-identity: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

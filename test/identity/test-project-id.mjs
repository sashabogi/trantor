#!/usr/bin/env node
// Project-id drill (#6724): renaming a project's directory used to orphan its Trantor identity.
// With the id recorded in the checkout the rename is a label change: resolve, checkout lookup, MCP
// registration, board, inbox, doctor and adopt all answer for the SAME project. Scratch home/bus/dev.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv, scrubIdentityEnv } from "../drill-env.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PORT = 47941;
const HUB = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { cond ? pass++ : fail++; console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : ` — ${detail}`}`); };

// ── scratch machine ──────────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), "trantor-project-id-"));
const home = join(work, "home");
const bus = join(home, ".agent-bus");        // doctor reads ~/.agent-bus by HOME; lib reads AGENT_BUS_DIR — one place
const dev = join(work, "development");
const oldDir = join(dev, "juans-project");
const newDir = join(dev, "stone-tracker");
mkdirSync(bus, { recursive: true });
mkdirSync(oldDir, { recursive: true });
const ENV = { HOME: home, AGENT_BUS_DIR: bus, TRANTOR_DEV_ROOT: dev, TRANTOR_NO_UPDATE_CHECK: "1" };
const env = (extra = {}) => { const e = drillEnv({ ...ENV, ...extra }); delete e.CLAUDE_PROJECT_DIR; return e; };
const run = (file, args, cwd, extra = {}) => spawnSync(process.execPath, [join(ROOT, file), ...args], { cwd, env: env(extra), encoding: "utf8" });
spawnSync("git", ["init", "-q", "-b", "main"], { cwd: oldDir });
// The global default points at the drill hub too, so an unpinned name can never reach a real hub.
writeFileSync(join(bus, "config.json"), JSON.stringify({ url: HUB, hubs: { "juans-project": HUB } }));

const api = {
  post: (p, b) => fetch(HUB + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json()),
  get: (p) => fetch(HUB + p).then(r => r.json()),
};
const hub = spawn(process.execPath, [join(ROOT, "hub.mjs")], {
  env: env({ RELAY_DATA_DIR: join(work, "hubdata"), RELAY_PORT: String(PORT), PORT: String(PORT), RELAY_AUTH: "off" }),
  stdio: ["ignore", "ignore", "pipe"],
});
for (let i = 0; i < 40; i++) { try { await api.get("/health"); break; } catch { await sleep(250); } }

// Boot the relay MCP from a directory and return its startup line (registration is done by then).
function bootMcp(cwd) {
  return new Promise((done) => {
    const kid = spawn(process.execPath, [join(ROOT, "mcp.mjs")], { cwd, env: env(), stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    const timer = setTimeout(() => finish(), 30_000);
    const finish = () => { clearTimeout(timer); try { kid.kill("SIGKILL"); } catch {} done(err.split("\n").find(l => l.includes("connected as")) || err); };
    kid.stderr.on("data", (d) => { err += d; if (err.includes("[trantor-mcp] connected as")) finish(); });
    kid.on("error", () => finish());
  });
}
const sessionOf = (line) => (/connected as (\S+) in (\S+) -> hub (\S+) via (\S+)/.exec(line) || []).slice(1);

scrubIdentityEnv();
console.log("# project identity survives a directory rename (#6724)");
try {
  // ── 1. claim the id in the checkout ──────────────────────────────────────
  {
    const r = run("bin/cli.mjs", ["project", "juans-project"], oldDir);
    ok("trantor project <id> records .trantor/project.json", r.status === 0 && existsSync(join(oldDir, ".trantor", "project.json")), r.stderr || r.stdout);
    const marker = JSON.parse(readFileSync(join(oldDir, ".trantor", "project.json"), "utf8"));
    ok("the marker carries the id and its claimant", marker.id === "juans-project" && marker.by === "trantor project", JSON.stringify(marker));
    const bad = run("bin/cli.mjs", ["project", "../escape"], oldDir);
    ok("a path-shaped id is refused", bad.status === 1 && /not a project id/.test(bad.stderr), bad.stderr);
    const other = run("bin/cli.mjs", ["project", "other-name"], oldDir);
    ok("re-claiming under another id needs --force", other.status === 1 && /refused/.test(other.stderr) && readFileSync(join(oldDir, ".trantor", "project.json"), "utf8").includes("juans-project"), other.stderr);
  }

  // ── 2. life under the old name: a session, a card, a message ─────────────
  const before = sessionOf(await bootMcp(oldDir));
  ok("the MCP registers as <host>:juans-project on the pinned hub", before[0]?.endsWith(":juans-project") && before[1] === "juans-project" && before[3] === "pin", before.join(" "));
  const session = before[0];
  await api.post("/task", { project: "juans-project", title: "survives the rename", by: session });
  await api.post("/send", { from: "drill:juans-project", to: session, text: "still here after the move?" });

  // ── 3. the rename ────────────────────────────────────────────────────────
  renameSync(oldDir, newDir);
  process.env.AGENT_BUS_DIR = bus;
  const { resolveProjectInfo, resolveProject, checkoutFor, markerProject } = await import(join(ROOT, "lib", "project.mjs"));
  const info = resolveProjectInfo(newDir, ENV);
  ok("the renamed checkout resolves to its recorded id, via the marker", info.project === "juans-project" && info.via === "marker", JSON.stringify(info));
  ok("a cwd deeper inside resolves the same way", resolveProject(join(newDir, "src", "deep"), ENV) === "juans-project");
  ok("checkoutFor(id) finds the renamed directory", checkoutFor("juans-project", ENV) === newDir, checkoutFor("juans-project", ENV));
  ok("the directory label is not a project", checkoutFor("stone-tracker", ENV) === "", checkoutFor("stone-tracker", ENV));
  mkdirSync(join(newDir, "vendor", "other"), { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: join(newDir, "vendor", "other") });
  ok("a nested repo does not inherit the parent's id", markerProject(join(newDir, "vendor", "other")) === "" && resolveProject(join(newDir, "vendor", "other"), ENV) === "other", resolveProject(join(newDir, "vendor", "other"), ENV));
  ok("RELAY_PROJECT still outranks the marker", resolveProjectInfo(newDir, { ...ENV, RELAY_PROJECT: "x" }).via === "env");

  // ── 4. the same session, board, peers and inbox ──────────────────────────
  const after = sessionOf(await bootMcp(newDir));
  ok("the MCP from the renamed dir registers as the SAME session in the same project", after[0] === session && after[1] === "juans-project" && after[3] === "pin", after.join(" "));
  const { peers = [] } = await api.get("/peers");
  ok("peers lists the session under juans-project, nothing under stone-tracker",
    peers.some(p => p.session === session && p.project === "juans-project") && !peers.some(p => p.project === "stone-tracker"),
    JSON.stringify(peers.map(p => [p.session, p.project])));
  const board = await api.get("/tasks?project=juans-project");
  const twin = await api.get("/tasks?project=stone-tracker");
  ok("the board carried over and the label minted no twin", (board.tasks || []).some(t => t.title === "survives the rename") && !(twin.tasks || []).length, `${(board.tasks || []).length} / ${(twin.tasks || []).length}`);
  const inbox = run("bin/inbox.mjs", ["--all", "--json"], newDir);
  const parsed = (() => { try { return JSON.parse(inbox.stdout); } catch { return null; } })();
  ok("trantor inbox from the renamed dir reads the same session's mail", parsed?.session === session && (parsed?.messages || []).some(m => m.text === "still here after the move?"), inbox.stderr || inbox.stdout.slice(0, 200));

  // ── 5. adopt finds the live thread by the recorded sid, not the new dir's slug ──
  {
    const sid = "11111111-2222-4333-8444-555555555555";
    writeFileSync(join(bus, "orch-sessions.txt"), `juans-project\t${sid}\n`);
    const oldSlug = oldDir.replace(/[/.]/g, "-");
    mkdirSync(join(home, ".claude", "projects", oldSlug), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", oldSlug, `${sid}.jsonl`), "{}\n");
    const r = run("bin/adopt.mjs", ["juans-project"], work);
    const plainOut = r.stdout.replace(/\x1b\[[0-9;]*m/g, "");
    ok("adopt finds the checkout and the transcript still written under the old slug", r.status === 0 && plainOut.includes(`recorded ${sid} as juans-project's orchestrator session`), r.stderr || plainOut);
  }

  // ── 6. doctor names an orphaned identity and the fix; the fix clears it ─────
  {
    const plain = join(dev, "renamed-plain");
    mkdirSync(plain, { recursive: true });
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: plain });
    writeFileSync(join(bus, "orch-sessions.txt"), `juans-project\t${"1".repeat(8)}\nold-name\t${"2".repeat(8)}\n`);
    const doctor = () => { const r = run("bin/doctor.mjs", ["--json"], plain); const last = r.stdout.trim().split("\n").pop(); try { return JSON.parse(last); } catch { return { issues: [], ok: [], notes: [], raw: r.stdout + r.stderr }; } };
    const d1 = doctor();
    const orphan = d1.issues.find(i => i.section === "project identity" && i.message.startsWith("orphaned identity: old-name"));
    ok("doctor names the orphaned identity (an orchestrator row with no checkout)", !!orphan, JSON.stringify(d1.issues.filter(i => i.section === "project identity")) || d1.raw);
    ok("the fix is the one command, aimed at this unmarked directory", /trantor project old-name/.test(orphan?.fix || "") && /"renamed-plain"/.test(orphan?.fix || ""), orphan?.fix);
    ok("doctor says the unmarked checkout is named by its directory", d1.notes.some(n => n.section === "project identity" && /named by its directory/.test(n.message)));
    ok("juans-project is not an orphan: its renamed checkout carries the id", !d1.issues.some(i => /orphaned identity: juans-project/.test(i.message)));
    run("bin/cli.mjs", ["project", "old-name"], plain);
    const d2 = doctor();
    ok("after the fix the doctor reads the id and the label", d2.ok.some(o => o.section === "project identity" && /old-name recorded in .trantor\/project.json — directory "renamed-plain" is a label/.test(o.message)), JSON.stringify(d2.ok.filter(o => o.section === "project identity")));
    ok("and the orphan is gone", !d2.issues.some(i => /orphaned identity: old-name/.test(i.message)));
  }
} finally {
  try { hub.kill("SIGKILL"); } catch {}
  rmSync(work, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

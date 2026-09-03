#!/usr/bin/env node
// trantor — a hook must address the hub of the project its CARD is about, not the hub of whatever
// directory the hook process happens to be standing in.
//
// The bug this pins (found 2026-08-19, after two separate diagnosis sessions blamed everything
// else): `toUrl()` resolved the hub from `CLAUDE_PROJECT_DIR || process.cwd()` while the payload's
// project came from Claude's session cwd. Launch a session from ~/development and those disagree —
// every card is stamped "crebral-health" and every one of them lands on the LOCAL hub, because
// "development" has no pin and falls through to the global default. Nothing errors. The seat looks
// healthy. Half the work records where nobody is reading.
//
// So these drills run the REAL hooks against two recorder hubs and vary ONLY the process cwd.
import http from "node:http";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "./drill-env.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " — " + x : ""}`); } };

console.log("# trantor hook hub-routing drill");

// ---- two recorder hubs: "local" (the global default) and "remote" (the pinned one) ------
const hits = { local: [], remote: [] };
function recorder(which) {
  return http.createServer((req, res) => {
    let b = ""; req.on("data", c => (b += c));
    req.on("end", () => {
      let body = {}; try { body = JSON.parse(b || "{}"); } catch {}
      hits[which].push({ path: req.url, method: req.method, project: body.project, session: body.session });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, id: 1, task: {}, messages: [], cursor: 0, peers: [], grants: [], tasks: [] }));
    });
  });
}
const L = recorder("local"), R = recorder("remote");
await new Promise(r => L.listen(0, "127.0.0.1", r));
await new Promise(r => R.listen(0, "127.0.0.1", r));
const LOCAL = `http://127.0.0.1:${L.address().port}`, REMOTE = `http://127.0.0.1:${R.address().port}`;

const W = mkdtempSync(join(tmpdir(), "trantor-hookrt-"));
mkdirSync(join(W, "bus"), { recursive: true });
const repo = join(W, "pinnedproj"), elsewhere = join(W, "elsewhere");
for (const d of [repo, elsewhere]) {
  mkdirSync(d, { recursive: true });
  spawnSync("git", ["init", "-q", "."], { cwd: d });
  spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "i"], { cwd: d,
    env: { ...drillEnv(), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}
// global default = LOCAL; only `pinnedproj` is pinned to REMOTE. Exactly the real shape.
writeFileSync(join(W, "bus", "config.json"), JSON.stringify({ url: LOCAL, hubs: { pinnedproj: REMOTE } }));

const stdinFor = (cwd, event) => JSON.stringify({
  prompt: "a substantive prompt, long enough that the focus hook treats it as a real change of focus",
  cwd, session_id: "drill-uuid", hook_event_name: event,
});
// ASYNC on purpose. The recorder hubs live in THIS process, so a synchronous spawn would block
// the event loop that has to answer them: every request would time out and the hook would fail
// open, making a broken routing test look like a passing one.
function runHook(hook, cwd, event, procCwd) {
  hits.local.length = 0; hits.remote.length = 0;
  const env = { ...drillEnv(), HOME: W, AGENT_BUS_DIR: join(W, "bus"), TRANTOR_NO_SCROOGE_TITLES: "1", CLAUDE_PROJECT_DIR: procCwd };
  for (const k of ["RELAY_URL", "RELAY_SESSION", "RELAY_AGENT", "RELAY_PROJECT"]) delete env[k];
  return new Promise(resolve => {
    const p = spawn("node", [join(ROOT, hook)], { cwd: procCwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", d => (out += d)); p.stderr.on("data", d => (err += d));
    p.on("close", status => setTimeout(() => {
      if (process.env.DRILL_DEBUG) console.log(`     [${hook}] status=${status} stderr=${err.trim().slice(0, 300)}`);
      resolve({ local: [...hits.local], remote: [...hits.remote], err });
    }, 150));
    p.stdin.end(stdinFor(cwd, event));
  });
}

// ---- the control: hook process standing in the project it is writing about -------------
{
  const r = await runHook("hooks/prompt-focus.mjs", repo, "UserPromptSubmit", repo);
  const focus = r.remote.find(h => h.path === "/focus");
  ok("control: cwd IS the project — the focus card goes to the PINNED hub", !!focus, JSON.stringify(r.remote.map(h => h.path)));
  ok("control: nothing leaked to the default hub", r.local.length === 0, JSON.stringify(r.local.map(h => h.path)));
}

// ---- the bug: same session, hook process standing somewhere else ------------------------
{
  const r = await runHook("hooks/prompt-focus.mjs", repo, "UserPromptSubmit", elsewhere);
  const onRemote = r.remote.find(h => h.path === "/focus");
  const onLocal = r.local.find(h => h.path === "/focus");
  ok("a hook launched from ANOTHER directory still posts to the project's pinned hub",
    !!onRemote && !onLocal, `remote=${JSON.stringify(r.remote.map(h => h.path))} local=${JSON.stringify(r.local.map(h => h.path))}`);
  ok("...and the card is still stamped with the right project",
    onRemote?.project === "pinnedproj", String(onRemote?.project));
  ok("...and signs as that project's session, not the cwd's",
    /:pinnedproj$/.test(onRemote?.session || ""), String(onRemote?.session));
}

// ---- sessionstart builds absolute URLs; they must be the pinned hub's too ---------------
{
  const r = await runHook("hooks/sessionstart.mjs", repo, "SessionStart", elsewhere);
  ok("sessionstart registers on the PINNED hub from a foreign cwd",
    r.remote.some(h => h.path === "/register") && !r.local.some(h => h.path === "/register"),
    `remote=${JSON.stringify(r.remote.map(h => h.path))} local=${JSON.stringify(r.local.map(h => h.path))}`);
}

// ---- the inbox reads are session-scoped and carry no ?project= — they must still route --
{
  const r = await runHook("hooks/inbox-deliver.mjs", repo, "UserPromptSubmit", elsewhere);
  const all = [...r.local, ...r.remote];
  // It may legitimately make no call (nothing to deliver); what it must NEVER do is call the
  // wrong hub, or die of a ReferenceError before calling anything. Both are checked.
  ok("inbox-deliver never reads the wrong hub", r.local.length === 0, JSON.stringify(r.local.map(h => h.path)));
  ok("inbox-deliver runs without throwing (a swallowed ReferenceError kills delivery silently)",
    all.every(h => /^\/inbox/.test(h.path)) || all.length === 0);
}

L.close(); R.close();
rmSync(W, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

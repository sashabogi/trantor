#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { sessionActivityReader } from "../../lib/session-liveness.mjs";
import { snapshotBeforeCut } from "../../bin/cut-snapshot.mjs";

mkdirSync(".agent-bus-out", { recursive: true });
const root = mkdtempSync(resolve(".agent-bus-out/session-drill-"));
const workDir = join(root, "repo"), home = join(root, "home"), db = join(root, "opencode.db");
mkdirSync(workDir); mkdirSync(home);
const run = (cmd, args, cwd = root) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
};
const sql = q => run("sqlite3", [db, q]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`PASS ${name}`); };
let wd;
try {
  sql(`CREATE TABLE session(id TEXT, directory TEXT, parent_id TEXT, time_created INTEGER);
    CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE part(id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER);`);
  const startedAt = Date.now();
  sql(`INSERT INTO session VALUES ('ses_own','${workDir}',NULL,${startedAt}),('ses_child','${workDir}','ses_own',${startedAt}),('ses_other','/other',NULL,${startedAt});`);
  const opts = { kind: "opencode", db, home, workDir, startedAt };
  const read = sessionActivityReader({ ...opts, sid: "ses_own" });
  sql(`INSERT INTO message VALUES('m','ses_other',${startedAt + 10},${startedAt + 10});`);
  check("another session cannot keep this seat alive", () => assert.equal(read(), 0));
  sql(`INSERT INTO part VALUES('p','ses_own',${startedAt + 20},${startedAt + 20});`);
  check("part row is activity without stdout or a worktree write", () => assert.equal(read(), startedAt + 20));
  sql(`INSERT INTO message VALUES('m2','ses_child',${startedAt + 30},${startedAt + 30});`);
  check("Explore child session is activity for its parent", () => assert.equal(read(), startedAt + 30));
  check("fresh session resolves by workdir and ignores child roots", () => assert.equal(sessionActivityReader(opts)(), startedAt + 30));
  check("old sessions cannot impersonate a fresh turn", () => assert.equal(sessionActivityReader({ ...opts, startedAt: startedAt + 100 })(), 0));
  check("missing DB falls back to other signals", () => assert.equal(sessionActivityReader({ ...opts, db: join(root, "absent") })(), 0));

  for (const kind of ["kimi", "claude", "kimi-python"]) {
    const transcriptDir = join(home, ".claude", "projects", "repo");
    const sessionDir = kind === "claude" ? join(transcriptDir, "own", "subagents")
      : kind === "kimi" ? join(home, ".kimi-code", "sessions", "wd_repo", "own", "agents", "explore")
      : join(home, ".kimi", "sessions", createHash("md5").update(workDir).digest("hex"), "own", "subagents");
    mkdirSync(sessionDir, { recursive: true });
    if (kind === "kimi") writeFileSync(join(home, ".kimi-code", "session_index.jsonl"), JSON.stringify({
      sessionId: "own", sessionDir: resolve(sessionDir, "../.."), workDir,
    }) + "\n");
    writeFileSync(join(sessionDir, "wire.jsonl"), '{}\n');
    const reader = sessionActivityReader({ kind: kind === "kimi-python" ? "kimi" : kind, home, workDir,
      sid: "own", transcriptDir, startedAt });
    if (kind === "kimi-python") rmSync(join(home, ".kimi-code"), { recursive: true });
    check(`${kind} own sub-agent log is activity`, () => assert.ok(reader() >= startedAt));
    const before = reader();
    const other = join(sessionDir, "../../../other"); mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "wire.jsonl"), '{}\n');
    check(`${kind} unrelated log does not advance pinned reader`, () => assert.equal(reader(), before));
  }

  // Real detached watchdog: DB-only progress survives several windows, then freezes and cuts.
  const stamp = join(root, "stamp"), err = join(root, "err"), marker = join(root, "stall");
  const arm = Date.now();
  writeFileSync(err, "");
  writeFileSync(stamp, JSON.stringify({ turn: 1, startedAt: arm, runner: `${process.pid}.test`,
    activity: { ...opts, sid: "ses_own", startedAt: arm } }));
  wd = spawn(process.execPath, ["bin/turn-watchdog.mjs", stamp, err, "600", "drill:test", "test",
    "http://127.0.0.1:1", "", workDir, marker], { cwd: process.cwd(), stdio: "inherit" });
  for (let i = 0; i < 15; i++) {
    sql(`UPDATE part SET time_updated=${Date.now()} WHERE id='p';`);
    await sleep(250);
    assert.equal(existsSync(marker), false, "advancing DB must prevent a cut");
  }
  check("real watchdog survives DB-only activity beyond its stall window", () => assert.equal(existsSync(marker), false));
  const deadline = Date.now() + 6000;
  while (!existsSync(marker) && Date.now() < deadline) await sleep(100);
  check("frozen DB, streams and tree still trigger a cut", () => assert.equal(existsSync(marker), true));

  run("git", ["init", "-q", "-b", "seat/drill"], workDir);
  run("git", ["config", "user.name", "drill"], workDir);
  run("git", ["config", "user.email", "drill@example.test"], workDir);
  writeFileSync(join(workDir, "tracked"), "initial\n");
  run("git", ["add", "-A"], workDir); run("git", ["commit", "-qm", "init"], workDir);
  appendFileSync(join(workDir, "tracked"), "preserve this edit\n");
  writeFileSync(join(workDir, "new file"), "preserve this untracked file\n");
  const nested = join(workDir, "scratch"); mkdirSync(nested);
  check("nested scratch directory cannot snapshot its parent checkout", () => {
    assert.deepEqual(snapshotBeforeCut(nested), { ok: true, files: 0 });
    assert.equal(run("git", ["log", "-1", "--format=%s"], workDir), "init");
  });
  const snap = snapshotBeforeCut(workDir);
  check("dirty cut commits tracked and untracked work", () => {
    assert.equal(snap.ok, true, snap.error); assert.equal(snap.files, 2);
    assert.equal(run("git", ["log", "-1", "--format=%s"], workDir), "wip: cut at stall, 2 files");
    assert.equal(run("git", ["status", "--porcelain"], workDir), "");
    assert.equal(run("git", ["show", "HEAD:new file"], workDir), "preserve this untracked file");
  });
  check("clean cut creates no empty snapshot", () => assert.deepEqual(snapshotBeforeCut(workDir), { ok: true, files: 0 }));
  run("git", ["switch", "-qc", "main"], workDir);
  writeFileSync(join(workDir, "new file"), "dirty\n");
  check("dirty non-seat tree refuses snapshot instead of committing on main", () => assert.equal(snapshotBeforeCut(workDir).ok, false));
  console.log(`${checks} passed, 0 failed`);
} finally {
  if (wd) wd.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
}

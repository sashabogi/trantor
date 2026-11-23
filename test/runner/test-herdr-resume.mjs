#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexSessionId, geminiSessionId, herdrReportArgs, runnerResumeArgv } from "../../lib/herdr-integration.mjs";
import { drillEnv } from "../drill-env.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const source = readFileSync(join(ROOT, "bin/crew-runner.mjs"), "utf8");
const base = { agent: "claude", persona: "claude-2", dir: "/work/tree", runnerPath: "/opt/trantor/bin/crew-runner.mjs", model: "sonnet", project: "trantor", hub: "http://hub:4477", sessionId: "session-1" };

for (const [driver, flag] of Object.entries({ claude: "--resume {SID}", codex: "resume {SID}", gemini: "-r {SID}", kimi: "-S {SID}" })) {
  assert.ok(source.includes(flag), `${driver} has an explicit session-id resume`);
  const argv = runnerResumeArgv({ ...base, agent: driver, driver });
  assert.equal(argv[0], "node");
  assert.equal(argv[argv.indexOf("--resume") + 1], base.sessionId);
  const report = herdrReportArgs({ pane: "w1:p1", agent: driver, state: "idle", sessionId: base.sessionId, resumeArgv: argv });
  assert.ok(report.includes("--agent-session-id"));
  assert.ok(report.includes("--"));
  assert.deepEqual(report.slice(report.indexOf("--") + 1), argv, `${driver} report carries the runner resume command`);
}
for (const driver of ["opencode", "deepseek", "openrouter"]) {
  const argv = runnerResumeArgv({ ...base, agent: driver, driver: "opencode" });
  assert.ok(argv.length > 0 && argv[argv.indexOf("--resume") + 1] === base.sessionId);
}
assert.ok(source.includes("next:  `opencode run --dir {DIR} -s {SID}"));
assert.deepEqual(runnerResumeArgv({ ...base, driver: "dsh" }), [], "dsh has no resumable headless session");
assert.deepEqual(runnerResumeArgv({ ...base, sessionId: "" }), [], "a fresh or swapped runner reports no stale session");
assert.deepEqual(runnerResumeArgv({ ...base, dir: "/work/it's" }), [], "an apostrophe rejects only the resume command");
assert.deepEqual(runnerResumeArgv({ ...base, model: "x".repeat(9000) }), [], "an oversize command is not sent to herdr");
const plain = herdrReportArgs({ pane: "w1:p1", agent: "dsh", state: "working" });
assert.ok(!plain.includes("--agent-session-id") && !plain.includes("--"));
console.log("ok 1 - report-agent carries exact resume commands per agent kind and omits unsafe or unavailable ones");

const fixture = mkdtempSync(join(ROOT, ".agent-bus-out", "herdr-resume-fixture-"));
try {
  const cwd = join(fixture, "seat");
  mkdirSync(cwd, { recursive: true });
  const day = new Date(), pad = n => String(n).padStart(2, "0");
  const codexDir = join(fixture, "codex", String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
  mkdirSync(codexDir, { recursive: true });
  const own = "123e4567-e89b-42d3-a456-426614174000";
  const other = "123e4567-e89b-42d3-a456-426614174001";
  const rollout = (id, directory) => `{"timestamp":"${day.toISOString()}","type":"session_meta","payload":{"id":"${id}","cwd":${JSON.stringify(directory)}}}\n`;
  writeFileSync(join(codexDir, `rollout-${day.toISOString()}-${own}.jsonl`), rollout(own, cwd));
  writeFileSync(join(codexDir, `rollout-${day.toISOString()}-${other}.jsonl`), rollout(other, join(fixture, "other")));
  assert.equal(codexSessionId(join(fixture, "codex"), cwd, 0), own);
  assert.equal(codexSessionId(join(fixture, "codex"), cwd, Date.now() + 1000), "");

  const hash = createHash("sha256").update(cwd).digest("hex");
  const chats = join(fixture, "gemini", "tmp", hash, "chats");
  mkdirSync(chats, { recursive: true });
  writeFileSync(join(chats, "session-one.json"), JSON.stringify({ sessionId: "gemini-own" }));
  assert.equal(geminiSessionId(join(fixture, "gemini"), cwd, 0), "gemini-own");
  assert.equal(geminiSessionId(join(fixture, "gemini"), join(fixture, "other"), 0), "");

  const modernRoot = join(fixture, "gemini-modern");
  mkdirSync(join(modernRoot, "tmp", "seat-slug", "chats"), { recursive: true });
  writeFileSync(join(modernRoot, "projects.json"), JSON.stringify({ projects: { [cwd]: "seat-slug" } }));
  writeFileSync(join(modernRoot, "tmp", "seat-slug", ".project_root"), cwd);
  writeFileSync(join(modernRoot, "tmp", "seat-slug", "chats", "session-modern.jsonl"),
    `${JSON.stringify({ sessionId: "gemini-modern", directories: [cwd] })}\n${JSON.stringify({ type: "user", content: "go" })}\n`);
  assert.equal(geminiSessionId(modernRoot, cwd, 0), "gemini-modern");
  console.log("ok 2 - discovered session ids match the seat worktree and current time window");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

const hub = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const path = new URL(req.url, "http://x").pathname;
    const body = path === "/inbox" || path === "/poll" ? { messages: [], cursor: 0 }
      : path === "/lessons" ? { lessons: [] }
      : path === "/policy" ? { links: [], autonomy: { "*": 1 } }
      : { ok: true };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
});
await new Promise(resolve => hub.listen(0, "127.0.0.1", resolve));
const hubUrl = `http://127.0.0.1:${hub.address().port}`;
const world = mkdtempSync(join(ROOT, ".agent-bus-out", "herdr-resume-run-"));
const home = join(world, "home"), work = join(world, "work"), bin = join(world, "bin");
mkdirSync(join(home, ".agent-bus"), { recursive: true });
mkdirSync(work, { recursive: true });
mkdirSync(bin, { recursive: true });
const cliLog = join(world, "cli.log"), herdrLog = join(world, "herdr.log");
writeFileSync(join(bin, "claude"), `#!/bin/sh\ncase "$1" in --help) exit 0;; esac\nprintf '%s\\n' "$*" >> ${JSON.stringify(cliLog)}\necho 'the drill turn did enough substantive work to finish cleanly and report its session.'\n`);
writeFileSync(join(bin, "herdr"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(herdrLog)}\n`);
chmodSync(join(bin, "claude"), 0o755);
chmodSync(join(bin, "herdr"), 0o755);
writeFileSync(join(home, ".agent-bus", "crew-windows.txt"), "trantor\therdr\tclaude\tw1:p1\tclaude\t\n");
const env = { ...drillEnv(), HOME: home, PATH: `${bin}:${process.env.PATH}`, RELAY_PROJECT: "trantor", RELAY_AGENT: "claude", RELAY_URL: hubUrl, CREW_KICKOFF: "finish the drill", TRANTOR_RETRY_MS: "1000" };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = path => { try { return readFileSync(path, "utf8"); } catch { return ""; } };
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await sleep(100);
  }
  throw new Error("runner drill timed out");
}
async function run(args, options = {}) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...env, ...options }, stdio: "ignore" });
  await waitFor(() => read(cliLog).split("\n").some(line => line.includes("-p ") || line.includes("--resume restored-session")));
  child.kill("SIGTERM");
  await new Promise(resolve => { child.once("exit", resolve); setTimeout(resolve, 2000); });
}

try {
  await run([join(ROOT, "bin/crew-runner.mjs"), "claude", work]);
  const report = read(herdrLog).split("\n").find(line => line.startsWith("pane report-agent") && line.includes("--agent-session-id"));
  assert.ok(report, read(herdrLog));
  const sid = report.match(/--agent-session-id (\S+)/)?.[1];
  assert.match(sid, /^[0-9a-f-]{36}$/);
  assert.ok(report.includes(`-- node ${join(ROOT, "bin/crew-runner.mjs")} claude ${work} --agent claude --persona claude --project trantor --hub ${hubUrl} --resume ${sid}`), report);
  assert.ok(read(cliLog).includes(`--session-id ${sid}`), "the reported id is the one Claude actually received");
  console.log("ok 3 - the real runner reports the live Claude session and its runner relaunch command");

  writeFileSync(cliLog, "");
  await run([join(ROOT, "bin/crew-runner.mjs"), "claude", work, "--agent", "claude", "--project", "trantor", "--hub", hubUrl, "--resume", "restored-session"]);
  assert.ok(read(cliLog).split("\n").some(line => line.startsWith("--resume restored-session") && line.includes(" -p ")), read(cliLog));
  assert.ok(!read(cliLog).includes("--session-id restored-session"), "restore does not start a fresh session");
  console.log("ok 4 - the emitted runner arguments restore the exact CLI session");
} finally {
  hub.close();
  rmSync(world, { recursive: true, force: true });
}

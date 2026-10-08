import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

mkdirSync(".agent-bus-out", { recursive: true });
const root = mkdtempSync(resolve(".agent-bus-out/runner-release-"));
const install = join(root, "install"), home = join(root, "home"), fakebin = join(root, "bin");
for (const dir of [install, home, fakebin, join(home, ".agent-bus")]) mkdirSync(dir, { recursive: true });
for (const dir of ["bin", "lib", "hooks"]) cpSync(resolve(dir), join(install, dir), { recursive: true });
const classifier = readFileSync(join(install, "lib/classify-failure.mjs"), "utf8");
const bump = version => {
  writeFileSync(join(install, "lib/classify-failure.mjs"), classifier.replace(
    'export function substantiveOutput(ownText) {',
    `export function substantiveOutput(ownText) { console.log("fixture classifier ${version}");`));
  writeFileSync(join(install, "package.json"), JSON.stringify({ type: "module", version }));
};
bump("1.0.0");
symlinkSync(process.execPath, join(fakebin, "node"));
const turns = join(root, "turns.jsonl"), release = join(root, "release");
writeFileSync(join(fakebin, "dsh"), `#!${process.execPath}
import * as fs from 'node:fs';
const prompt = process.argv.slice(2).join(' ');
fs.appendFileSync(${JSON.stringify(turns)}, JSON.stringify({ prompt, parent: process.ppid }) + '\\n');
if (prompt.includes('MIDTURN')) while (!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
console.log('Implemented the requested fixture change and verified its output successfully. '.repeat(5));
`, { mode: 0o755 });
for (const cmd of ["docker", "git", "sqlite3", "osascript"]) writeFileSync(join(fakebin, cmd), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
let queue = [], cursor = 40;
const polls = [], sends = [];
let inboxReads = 0, bumpOnWake = "";
const server = createServer((req, res) => {
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", () => {
    const url = new URL(req.url, "http://fixture");
    const reply = data => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (url.pathname === "/send") { sends.push(JSON.parse(body)); return reply({ ok: true }); }
    if (url.pathname === "/inbox") { inboxReads++; return reply({ messages: [], cursor }); }
    if (url.pathname === "/poll") {
      polls.push(Number(url.searchParams.get("since")));
      const messages = queue; queue = [];
      if (messages.length && bumpOnWake) { bump(bumpOnWake); bumpOnWake = ""; }
      return setTimeout(() => reply({ messages, cursor }), 50);
    }
    if (url.pathname === "/lessons") return reply({ lessons: [] });
    if (url.pathname === "/contracts") return reply({ contracts: [] });
    if (url.pathname === "/tasks") return reply({ tasks: [] });
    return reply({ ok: true });
  });
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
let output = "";
const runner = spawn(process.execPath, [join(install, "bin/crew-runner.mjs"), "dsh", root], {
  cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: true,
  env: { HOME: home, PATH: `${fakebin}:/usr/bin:/bin`, RELAY_PROJECT: "release-drill", RELAY_AGENT: "dsh",
    RELAY_URL: `http://127.0.0.1:${server.address().port}`, CREW_KICKOFF: "fixture kickoff",
    TRANTOR_NO_KEYCHAIN: "1", TRANTOR_SECRETS_BACKEND: "file", TRANTOR_NO_DESKTOP_NOTIFY: "1",
    TRANTOR_TURN_MAX_MS: "0" },
});
runner.stdout.on("data", c => { output += c; });
runner.stderr.on("data", c => { output += c; });
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 20000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${label}\n${output.slice(-12000)}`);
    await sleep(40);
  }
};
const rows = () => existsSync(turns) ? readFileSync(turns, "utf8").trim().split("\n").map(JSON.parse) : [];
const restarts = () => sends.filter(s => s.text?.startsWith("runner restarted onto"));
const wake = text => { cursor++; queue.push({ id: cursor, from: "orch:release-drill", to: "dsh:release-drill", text, ts: Date.now() }); };
try {
  await waitFor(() => polls.length > 0, "initial runner idle");
  bumpOnWake = "1.1.0";
  wake("HELD_CONTRACT implement fixture");
  await waitFor(() => rows().some(r => r.prompt.includes("HELD_CONTRACT")), "held wake delivered after exec");
  assert.deepEqual(restarts().map(s => s.text), ["runner restarted onto 1.1.0"]);
  assert.equal(rows().filter(r => r.prompt.includes("fixture kickoff")).length, 1);
  assert.equal(inboxReads, 1, "restart must not jump to current inbox tip");
  assert.match(output, /1 message\(s\) survived from a previous run/);
  await waitFor(() => output.includes("classified success") || polls.length > 4, "turn settled");
  wake("MIDTURN implement fixture");
  await waitFor(() => rows().some(r => r.prompt.includes("MIDTURN")), "turn starts");
  bump("1.2.0");
  await sleep(350);
  assert.equal(restarts().length, 1, "mid-turn bump cannot exec");
  writeFileSync(release, "finish");
  await waitFor(() => restarts().length === 2, "exec after turn ends");
  wake("AFTER_RELEASE implement fixture");
  await waitFor(() => rows().some(r => r.prompt.includes("AFTER_RELEASE")), "new runner handles subsequent wake");
  await sleep(300);
  assert.deepEqual(restarts().map(s => s.text), ["runner restarted onto 1.1.0", "runner restarted onto 1.2.0"]);
  assert.match(output, /fixture classifier 1\.2\.0/);
  assert.equal(rows().filter(r => r.prompt.includes("HELD_CONTRACT")).length, 1, "held contract delivered exactly once");
  bump("1.1.0");
  await sleep(200);
  assert.equal(restarts().length, 2, "downgrade does not restart the runner");
  const boots = readFileSync(join(home, ".agent-bus/logs/dsh-release-drill.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(boots.filter(r => r.boot).length, 3, "exactly two execs");
  assert.ok(boots.filter(r => r.boot).every(r => r.pid === runner.pid), "exec preserves PID");
  assert.equal(boots.filter(r => r.text?.startsWith("runner restarted onto")).length, 2, "seat log records both releases");
  process.kill(runner.pid, 0);
  console.log("PASS runner release drill: held wake, cursor, stable PID, one exec per version, mid-turn deferral, bus and seat logs");
} finally {
  try { process.kill(-runner.pid, "SIGKILL"); } catch {}
  await new Promise(r => runner.once("close", r));
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  rmSync(root, { recursive: true, force: true });
}

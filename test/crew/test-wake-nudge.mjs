// #7429: socket protocol, local resolution, shared ledger and an opt-in real Claude wake drill.
// WAKE_NUDGE_LIVE=1 enables both parked-Claude drills; sockets use a short tmpdir path.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createServer as netServer } from "node:net";
import { createServer as httpServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, copyFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { resolveRecipient, tokenFromEnvironment, processRows, wakeOnce, keepalivePlist } from "../../bin/wake-nudge.mjs";
import { planDutyNudges, readDutyNudgeState } from "../../lib/duty-nudges.mjs";
import { ledgerPaths } from "../../hooks/lib/inbox-ledger.mjs";

const root = resolve(".");
const out = join(root, ".agent-bus-out");
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(out, "wn-"));
const sockets = mkdtempSync(join(tmpdir(), "wn-"));
after(() => rmSync(sockets, { recursive: true, force: true }));
const recipient = "local:trantor";
const sid = randomUUID();
const alert = (id = 51, to = recipient) => ({ id: id + 1000, by: "hub:duty", type: "message", ts: Date.now(), text: `UNDELIVERED for 2m: #${id} sender:trantor -> ${to} — "untrusted content"` });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const value = path => existsSync(path) ? Number(readFileSync(path, "utf8")) : 0;
async function until(check, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await delay(100); }
  throw new Error("deadline expired");
}

function fixtureCommand(socketPath, options = {}) {
  return (cmd, args) => {
    if (cmd === "herdr" && args[0] === "agent") return JSON.stringify({ result: { agents: options.noPane ? [] : [{ agent: "claude", cwd: "/work/trantor", pane_id: "w1:p1", agent_session: { value: sid } }] } });
    if (cmd === "ps" && args[0] === "-axo") return `101 1 claude --resume ${sid}\n102 101 node mcp.mjs\n103 101 claude --resume another\n104 103 node nested.mjs\n${options.duplicate ? `105 1 claude --resume ${sid}` : ""}`;
    if (cmd === "ps") {
      assert.deepEqual(args, ["eww", "-p", args[2]], "environment reads retain default ps columns");
      const envPid = options.directToken ? "101" : "102";
      return args[2] === envPid ? `PID TTY STAT TIME COMMAND\n${envPid} ?? S 0:00 claude CLAUDE_CODE_MESSAGING_SOCKET=${socketPath} CLAUDE_CODE_MESSAGING_TOKEN=private-token` : "no-token";
    }
    throw new Error("unexpected command");
  };
}

test("resolves mapped session and inherited token without crossing nested Claude sessions", () => {
  const bus = join(dir, "resolve"); mkdirSync(bus);
  writeFileSync(join(bus, "orch-sessions.txt"), `trantor\t${sid}\n`);
  const socketPath = join(sockets, "101.sock"); writeFileSync(socketPath, "");
  const options = { bus, localHost: "local", socketDir: sockets, command: fixtureCommand(socketPath) };
  assert.equal(resolveRecipient(recipient, options).pid, 101);
  assert.equal(resolveRecipient(recipient, { ...options, command: fixtureCommand(socketPath, { directToken: true }) }).token, "private-token");
  assert.equal(resolveRecipient(recipient, { ...options, command: fixtureCommand(socketPath, { noPane: true }) }).sid, sid);
  assert.equal(resolveRecipient("remote:trantor", options), null);
  assert.equal(resolveRecipient("claude:trantor", options), null);
  assert.equal(resolveRecipient(recipient, { ...options, command: fixtureCommand(socketPath, { duplicate: true }) }), null);
  assert.equal(tokenFromEnvironment("CLAUDE_CODE_MESSAGING_SOCKET=/wrong CLAUDE_CODE_MESSAGING_TOKEN=secret", socketPath), "");
  assert.equal(processRows("invalid\n1 0 claude").length, 1);
});

test("NDJSON wake advances poll, records once, and excludes sender-controlled content", async () => {
  const bus = join(dir, "success"); mkdirSync(bus);
  const socketPath = join(sockets, "s.sock");
  const pollStamp = ledgerPaths(recipient, sid, bus).pollStamp;
  let count = 0;
  const server = netServer(socket => {
    let data = "";
    socket.on("data", chunk => { data += chunk; });
    socket.on("end", () => {
      const lines = data.trim().split("\n").map(line => JSON.parse(line));
      assert.deepEqual(lines[0], { type: "auth", token: "secret" });
      assert.equal(lines[1].type, "user");
      assert.equal(lines[1].session_id, sid);
      assert.match(lines[1].message.content, /^<cross-session-message from="trantor:wake">/);
      assert.match(lines[1].message.content, /#51/);
      assert.doesNotMatch(lines[1].message.content, /untrusted content/);
      count++; writeFileSync(pollStamp, String(Date.now())); socket.end();
    });
  }).listen(socketPath);
  await once(server, "listening");
  const event = alert();
  const api = async path => path.startsWith("/events") ? { events: [event] } : { deliveredUpTo: 0 };
  const options = { bus, api, resolver: () => ({ sid, socketPath, token: "secret", pollStamp }), verifyMs: 200 };
  try {
    assert.equal((await wakeOnce(options)).nudged.length, 1);
    assert.equal((await wakeOnce(options)).nudged.length, 0);
    assert.equal(count, 1);
    assert.equal((await planDutyNudges([{ from: "hub:duty", text: event.text }], join(bus, "duty-nudged.json"))).items.length, 0);
  } finally { server.close(); }
});

test("held, closed, remote, and already delivered alerts remain available or untouched", async () => {
  const bus = join(dir, "fallthrough"); mkdirSync(bus);
  const socketPath = join(sockets, "h.sock");
  let posts = 0;
  const server = netServer(socket => { posts++; socket.resume(); socket.on("end", () => socket.end()); }).listen(socketPath);
  await once(server, "listening");
  const events = [alert(52)];
  const api = async path => path.startsWith("/events") ? { events } : { deliveredUpTo: 0 };
  const options = { bus, api, resolver: () => ({ sid, socketPath, token: "secret", pollStamp: join(bus, "no-poll") }), verifyMs: 100 };
  try {
    const attempted = new Set();
    assert.equal((await wakeOnce({ ...options, attempted })).missing.length, 1);
    assert.equal((await wakeOnce({ ...options, attempted })).missing.length, 0);
    assert.deepEqual(readDutyNudgeState(join(bus, "duty-nudged.json")).nudged, {});
    assert.deepEqual(readDutyNudgeState(join(bus, "duty-nudged.json")).planned, {});
    assert.equal((await planDutyNudges([{ from: "hub:duty", text: events[0].text }], join(bus, "duty-nudged.json"))).items.length, 1);
    assert.equal((await wakeOnce({ ...options, resolver: () => null })).missing.length, 0);
    assert.equal((await wakeOnce({ ...options, api: async path => path.startsWith("/events") ? { events } : { deliveredUpTo: 52 } })).nudged.length, 0);
    assert.equal(posts, 1);
  } finally { server.close(); }
  assert.equal((await wakeOnce(options)).missing.length, 1);
});

test("launchd plist keeps the daemon alive and escapes paths", () => {
  const plist = keepalivePlist({ bus: "/a&b", hub: "http://localhost:1", home: dir, path: "/bin" });
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>30<\/integer>/);
  assert.match(plist, /\/a&amp;b/);
  const path = join(dir, "wake.plist"); writeFileSync(path, plist);
  if (process.platform === "darwin") execFileSync("plutil", ["-lint", path]);
});

test("event cursor reads only new alerts, retains failed polls and resets after hub replacement", async () => {
  const cursor = { id: 0, ts: 0 };
  let events = [alert(61)];
  let latest = events[0].id;
  const paths = [];
  let resolutions = 0;
  const api = async path => {
    paths.push(path);
    const since = Number(new URL(path, "http://localhost").searchParams.get("since"));
    return { events: events.filter(event => event.id > since), latest };
  };
  const options = { api, cursor, resolver: () => { resolutions++; return null; } };
  await wakeOnce(options);
  assert.deepEqual(cursor, { id: 1061, ts: events[0].ts });
  await wakeOnce(options);
  assert.equal(resolutions, 1);
  assert.match(paths[1], /since=1061$/);
  assert.doesNotMatch(paths[1], /limit=2000/);
  events.push(alert(62)); latest++;
  await wakeOnce(options);
  assert.equal(resolutions, 2);
  assert.equal(cursor.id, 1062);
  await assert.rejects(wakeOnce({ ...options, api: async () => { throw new Error("hub unavailable"); } }), /hub unavailable/);
  assert.equal(cursor.id, 1062);
  latest = 1; events = [];
  await wakeOnce(options);
  assert.deepEqual(cursor, { id: 0, ts: 0 });
});

test("duty CLI installs, reports and stops both services, propagating failures", { skip: process.platform !== "darwin" }, () => {
  const fixture = join(dir, "cli");
  const bin = join(fixture, "bin"); mkdirSync(bin, { recursive: true });
  const home = join(fixture, "home"); mkdirSync(home);
  const bus = join(home, ".agent-bus"); mkdirSync(join(bus, "keys"), { recursive: true });
  for (const file of ["cli.mjs", "wake-nudge.mjs"]) copyFileSync(join(root, "bin", file), join(bin, file));
  for (const folder of ["lib", "hooks"]) symlinkSync(join(root, folder), join(fixture, folder));
  const log = join(fixture, "calls.jsonl");
  writeFileSync(join(bin, "duty.mjs"), `import {appendFileSync} from 'node:fs';
appendFileSync(process.env.WAKE_TEST_LOG, JSON.stringify(['duty',...process.argv.slice(2)])+'\\n');
console.log('com.trantor.duty '+(process.argv[2]||'status'));
process.exit(Number(process.env.WAKE_TEST_DUTY_EXIT||0));`);
  writeFileSync(join(bin, "launchctl"), `#!${process.execPath}
import {appendFileSync} from 'node:fs';
appendFileSync(process.env.WAKE_TEST_LOG, JSON.stringify(['launchctl',...process.argv.slice(2)])+'\\n');
console.log(process.argv.slice(2).join(' '));
if(process.argv[2]==='bootstrap') process.exit(Number(process.env.WAKE_TEST_LAUNCH_EXIT||0));`, { mode: 0o700 });
  writeFileSync(join(bus, "keys", "claude_trantor-duty.json"), JSON.stringify({ pubkey: "fixture", privkey: "fixture" }));
  const env = { ...process.env, HOME: home, AGENT_BUS_DIR: bus, PATH: `${bin}:${process.env.PATH}`, WAKE_TEST_LOG: log };
  const invoke = (args, extra = {}) => execFileSync(process.execPath, [join(bin, "cli.mjs"), "duty", ...args], { env: { ...env, ...extra }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const plist = join(home, "Library", "LaunchAgents", "com.trantor.wake-nudge.plist");
  assert.match(invoke(["up", "--hub", "http://localhost:54321"]), /com.trantor.wake-nudge installed/);
  assert.match(readFileSync(plist, "utf8"), /http:\/\/localhost:54321/);
  assert.equal(calls()[0][0], "duty");
  assert.ok(calls().some(row => row[1] === "bootstrap"));
  const status = invoke([]);
  assert.match(status, /com.trantor.duty status/);
  assert.match(status, /com.trantor.wake-nudge/);
  let before = calls().length;
  invoke(["down"]);
  assert.equal(calls()[before][1], "bootout");
  assert.equal(calls().at(-1)[0], "duty");
  assert.equal(existsSync(plist), false);
  before = calls().length;
  assert.throws(() => invoke(["up"], { WAKE_TEST_DUTY_EXIT: "7" }), error => error.status === 7);
  assert.equal(calls().length, before + 1, "failed duty start must not install wake service");
  assert.throws(() => invoke(["up"], { WAKE_TEST_LAUNCH_EXIT: "8" }), error => error.status !== 0);
  assert.throws(() => invoke(["status"], { WAKE_TEST_DUTY_EXIT: "7" }), error => error.status === 7 && /com.trantor.wake-nudge/.test(error.stdout));
  assert.throws(() => invoke(["down"], { WAKE_TEST_DUTY_EXIT: "7" }), error => error.status === 7);
  assert.equal(existsSync(plist), false);
});

for (const mode of ["accept", "hold"]) test(`parked claude -p respects ${mode} on UNDELIVERED`, { skip: process.env.WAKE_NUDGE_LIVE !== "1", timeout: 90000 }, async () => {
  const home = join(dir, `live-${mode}`); mkdirSync(home);
  const bus = join(home, ".agent-bus"); mkdirSync(bus);
  const sessionId = randomUUID();
  const stamp = ledgerPaths(recipient, sessionId, bus).pollStamp;
  let events = [];
  let inboxPolls = 0;
  const hub = httpServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/inbox") inboxPolls++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(path === "/events" ? { events } : path === "/inbox" ? { messages: [], cursor: 0 } : { ok: true, deliveredUpTo: 0 }));
  }).listen(0, "127.0.0.1");
  await once(hub, "listening");
  const url = `http://127.0.0.1:${hub.address().port}`;
  const mcp = join(home, "mcp.mjs");
  writeFileSync(mcp, `import {createInterface} from 'node:readline';
const input=createInterface({input:process.stdin});
input.on('line',line=>{ const q=JSON.parse(line); if(q.id===undefined)return;
const result=q.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'drill',version:'1'}}:q.method==='tools/list'?{tools:[{name:'relay_inbox',description:'Read the Trantor bus inbox.',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:'Inbox empty. Reply OK and end your turn.'}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n'); });\n`);
  const settings = { crossSessionInbound: mode, hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `${process.execPath} ${join(root, "hooks/inbox-deliver.mjs")}` }] }] } };
  let token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    const credentials = JSON.parse(execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    token = credentials.claudeAiOauth.accessToken;
  }
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CLAUDE_CODE_OAUTH_TOKEN: token, AGENT_BUS_DIR: bus, RELAY_PROJECT: "trantor", RELAY_SESSION: recipient, RELAY_HOST_ID: "local", RELAY_URL: url, RELAY_INBOX_POLL_MS: "0", WAKE_DRILL_DIR: sockets };
  delete env.CLAUDECODE; delete env.CLAUDE_CODE_MESSAGING_TOKEN; delete env.CLAUDE_CODE_MESSAGING_SOCKET;
  const child = spawn("/bin/sh", ["-c", 'exec claude --messaging-socket-path "$WAKE_DRILL_DIR/$$.sock" "$@"', "wake-drill", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--session-id", sessionId, "--model", "haiku", "--setting-sources", "", "--settings", JSON.stringify(settings), "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: { drill: { command: process.execPath, args: [mcp] } } }), "--allowedTools", "mcp__drill__relay_inbox", "--no-session-persistence"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let output = ""; let errors = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  writeFileSync(join(bus, "orch-sessions.txt"), `trantor\t${sessionId}\n`);
  try {
    child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "Call relay_inbox once, then reply READY. Do nothing else." } }) + "\n");
    await until(() => output.includes('"type":"result"') && value(stamp) > 0, 55000);
    const before = value(stamp);
    await delay(700);
    assert.equal(value(stamp), before, "recipient is parked with no polling activity");
    events = [alert(53)];
    const started = Date.now();
    const command = (cmd, args) => cmd === "herdr" ? JSON.stringify({ result: { agents: [] } }) : execFileSync(cmd, args, { encoding: "utf8" });
    const resolver = target => resolveRecipient(target, { bus, localHost: "local", command, socketDir: sockets });
    assert.ok(resolver(recipient), "resolve live Claude pid and inherited messaging token");
    const result = await wakeOnce({ bus, resolver, api: async path => (await fetch(url + path)).json() });
    if (mode === "hold") {
      assert.equal(result.nudged.length, 0);
      assert.equal(result.missing.length, 1);
      assert.equal(value(stamp), before);
      assert.deepEqual(readDutyNudgeState(join(bus, "duty-nudged.json")).planned, {});
      return;
    }
    assert.equal(result.nudged.length, 1);
    assert.ok(value(stamp) > before);
    assert.ok(Date.now() - started < 15000);
    assert.ok(inboxPolls >= 2);
    const evidence = { card: 7429, pid: child.pid, before, after: value(stamp), elapsedMs: Date.now() - started, inboxPolls, nudged: result.nudged.map(item => item.id) };
    writeFileSync(join(out, "wake-nudge-drill-result.json"), JSON.stringify(evidence, null, 2) + "\n");
    console.log(JSON.stringify(evidence));
  } catch (error) {
    writeFileSync(join(home, "drill-output.jsonl"), output, { mode: 0o600 });
    writeFileSync(join(home, "drill-errors.txt"), errors, { mode: 0o600 });
    throw error;
  } finally {
    child.kill("SIGTERM"); hub.close();
  }
});

#!/usr/bin/env node
// #14067 drills: the turn-row shipper against a stub hub — first ship with no cursor, resume from
// the cursor, a hub outage with one failure line and one recovery line, a partial last line, history
// rows without an id, batching at 100, the runner's write path, and `trantor telemetry ship --all`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import http from "node:http";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import "../drill-env.mjs";
import { completeTurnRow, isTurnRow, seatForTelemetryFile, shipTurnRows, telemetryDir, telemetryFiles, turnRowId } from "../../lib/telemetry-ship.mjs";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const outputDir = join(ROOT, ".agent-bus-out");
fs.mkdirSync(outputDir, { recursive: true });

const turnRow = (n, extra = {}) => ({
  ts: 1700000000000 + n * 1000, persona: "glm-5", agent: "glm", project: "trantor",
  turn: n, trigger: "message", card: 14067, model: "glm-5.3", duration_ms: 1000 + n,
  exit: 0, effExit: 0, outcome: "completed", verdict: `turn ${n} done`, tokens: 10 + n, ...extra,
});
const writeLog = (file, rows) => fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
const cursorFile = () => join(telemetryDir(), ".shipped-glm-5-trantor");
const cursorValue = () => Number(fs.readFileSync(cursorFile(), "utf8"));
const downFile = () => join(telemetryDir(), ".shipped-glm-5-trantor.down");

// A throwaway bus dir per test: the shipper reads AGENT_BUS_DIR at call time, so overriding it here
// keeps every drill off the real ~/.agent-bus.
function busFor(t) {
  const bus = fs.mkdtempSync(join(outputDir, "telemetry-ship-"));
  fs.mkdirSync(join(bus, "logs"), { recursive: true });
  const prev = process.env.AGENT_BUS_DIR;
  process.env.AGENT_BUS_DIR = bus;
  t.after(() => { process.env.AGENT_BUS_DIR = prev; fs.rmSync(bus, { recursive: true, force: true }); });
  return bus;
}

function startStubHub() {
  const rows = [];
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      if (req.url === "/enroll") { res.writeHead(200, { "content-type": "application/json" }); return res.end("{}"); }
      if (req.url === "/telemetry/turns") {
        const batch = JSON.parse(body || "{}").rows || [];
        let stored = 0, duplicates = 0;
        for (const row of batch) {
          if (rows.some(r => r.id === row.id)) duplicates++;
          else { rows.push(row); stored++; }
        }
        requests.push(batch);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, stored, duplicates, dropped: 0 }));
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({
    base: `http://127.0.0.1:${server.address().port}`,
    rows, requests,
    stop: () => new Promise(r => server.close(r)),
  })));
}

test("a turn row gains id, v and machine, and its verdict is cut to 600", () => {
  const row = completeTurnRow(turnRow(3, { verdict: "x".repeat(900) }), "netcup");
  assert.equal(row.id, turnRowId("glm-5", "trantor", row.ts, 3));
  assert.equal(row.v, 1);
  assert.equal(row.machine, "netcup");
  assert.equal(row.verdict.length, 600);
  assert.equal(completeTurnRow(turnRow(3), "").machine, "", "an empty machine label is sent as an empty string, never omitted: the hub rejects a missing key");
  assert.deepEqual(completeTurnRow({ ts: 1, text: "note", version: "1.2" }), { ts: 1, text: "note", version: "1.2" });
  assert.equal(isTurnRow({ turn: 0 }), false, "turn 0 is not a turn");
  assert.equal(isTurnRow({ turn: "3" }), false, "a string turn is not a turn");
});

test("first ship with no cursor: turn rows only, oldest first, history rows get the computed id", async t => {
  const bus = busFor(t);
  const hub = await startStubHub();
  t.after(() => hub.stop());
  const file = join(bus, "logs", "glm-5-trantor.jsonl");
  writeLog(file, [
    { ts: 1700000000000, persona: "glm-5", agent: "glm", project: "trantor", boot: true, hub: hub.base, pid: 1, version: "1" },
    turnRow(1), turnRow(2),
    { ts: 1700000000500, text: "a text note is never a turn", version: "1" },
    turnRow(3),
  ]);
  const r = await shipTurnRows({ persona: "glm-5", project: "trantor", hub: hub.base, log: () => {} });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.stored, 3);
  assert.deepEqual(hub.rows.map(row => row.turn), [1, 2, 3], "oldest first, boot and text rows never shipped");
  assert.equal(hub.rows[0].id, turnRowId("glm-5", "trantor", 1700000001000, 1));
  for (const row of hub.rows) assert.match(row.id, /^[0-9a-f]{32}$/);
  assert.equal(cursorValue(), fs.statSync(file).size, "the cursor lands at the end of the file");
  assert.equal(hub.rows[0].verdict, "turn 1 done", "a short verdict passes whole");
});

test("resume from the cursor: only rows appended after it ship again", async t => {
  const bus = busFor(t);
  const hub = await startStubHub();
  t.after(() => hub.stop());
  const file = join(bus, "logs", "glm-5-trantor.jsonl");
  writeLog(file, [turnRow(1), turnRow(2)]);
  await shipTurnRows({ persona: "glm-5", project: "trantor", hub: hub.base, log: () => {} });
  fs.appendFileSync(file, `${JSON.stringify(turnRow(3))}\n${JSON.stringify(turnRow(4))}\n`);
  const r = await shipTurnRows({ persona: "glm-5", project: "trantor", hub: hub.base, log: () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.stored, 2);
  assert.equal(r.duplicates, 0);
  assert.deepEqual(hub.rows.map(row => row.turn), [1, 2, 3, 4]);
  assert.equal(cursorValue(), fs.statSync(file).size);
});

test("250 rows ship oldest-first in batches of at most 100", async t => {
  const bus = busFor(t);
  const hub = await startStubHub();
  t.after(() => hub.stop());
  const file = join(bus, "logs", "glm-5-trantor.jsonl");
  writeLog(file, Array.from({ length: 250 }, (_, i) => turnRow(i + 1)));
  const r = await shipTurnRows({ persona: "glm-5", project: "trantor", hub: hub.base, log: () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.stored, 250);
  assert.deepEqual(hub.requests.map(b => b.length), [100, 100, 50]);
  assert.equal(hub.requests[0][0].turn, 1, "the first batch starts at the oldest row");
  assert.equal(cursorValue(), fs.statSync(file).size);
});

test("hub down then up: the cursor holds, one failure line, one recovery line", async t => {
  const bus = busFor(t);
  const file = join(bus, "logs", "glm-5-trantor.jsonl");
  writeLog(file, [turnRow(1), turnRow(2)]);
  const logs = [];
  const dead = "http://127.0.0.1:1";
  const deadOpts = { persona: "glm-5", project: "trantor", hub: dead, log: s => logs.push(s) };
  assert.equal((await shipTurnRows(deadOpts)).ok, false);
  assert.equal((await shipTurnRows(deadOpts)).ok, false);
  assert.equal(logs.filter(l => l.includes("could not report turns")).length, 1, "one failure line per episode");
  assert.ok(!fs.existsSync(cursorFile()), "a failed ship never advances the cursor");
  assert.ok(fs.existsSync(downFile()), "the episode is marked on disk for the next boot");
  const hub = await startStubHub();
  t.after(() => hub.stop());
  const r = await shipTurnRows({ persona: "glm-5", project: "trantor", hub: hub.base, log: s => logs.push(s) });
  assert.equal(r.ok, true);
  assert.equal(r.stored, 2, "the queued rows arrive after the outage");
  assert.equal(logs.filter(l => l.includes("recovered")).length, 1, "one recovery line");
  assert.ok(!fs.existsSync(downFile()), "the episode marker is lifted on recovery");
});

test("a partial last line is never shipped and the cursor stops before it", async t => {
  const bus = busFor(t);
  const hub = await startStubHub();
  t.after(() => hub.stop());
  const file = join(bus, "logs", "glm-5-trantor.jsonl");
  writeLog(file, [turnRow(1), turnRow(2)]);
  const line3 = JSON.stringify(turnRow(3));
  fs.appendFileSync(file, line3.slice(0, 40));
  let r = await shipTurnRows({ persona: "glm-5", project: "trantor", hub: hub.base, log: () => {} });
  assert.equal(r.ok, true);
  assert.deepEqual(hub.rows.map(row => row.turn), [1, 2]);
  const before = cursorValue();
  assert.equal(before, line3.length * 2 + 2, "the cursor stops at the end of the last complete line");
  fs.appendFileSync(file, `${line3.slice(40)}\n`);
  r = await shipTurnRows({ persona: "glm-5", project: "trantor", hub: hub.base, log: () => {} });
  assert.equal(r.stored, 1, "the completed line ships on the next pass");
  assert.deepEqual(hub.rows.map(row => row.turn), [1, 2, 3]);
});

test("a file of boot and text rows only posts nothing and still advances the cursor", async t => {
  const bus = busFor(t);
  const hub = await startStubHub();
  t.after(() => hub.stop());
  const file = join(bus, "logs", "glm-5-trantor.jsonl");
  writeLog(file, [
    { ts: 1700000000000, persona: "glm-5", agent: "glm", project: "trantor", boot: true },
    { ts: 1700000000500, text: "note", version: "1" },
  ]);
  const r = await shipTurnRows({ persona: "glm-5", project: "trantor", hub: hub.base, log: () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.requests, 0);
  assert.equal(hub.requests.length, 0);
  assert.equal(cursorValue(), fs.statSync(file).size);
});

test("the runner records completed turn rows and ships at boot and after each turn row", async t => {
  const bus = busFor(t);
  const LOGDIR = join(bus, "logs");
  const shipped = [];
  const source = fs.readFileSync(join(ROOT, "bin/crew-runner.mjs"), "utf8");
  const helper = source.slice(source.indexOf("// #14067: the jsonl stays"), source.indexOf("// A seat can open a terminal"));
  const context = createContext({
    appendFileSync: fs.appendFileSync, join,
    isTurnRow, completeTurnRow, shipTurnRows: opts => shipped.push(opts),
    LOGDIR, PERSONA: "glm-5", PROJ: "trantor", AGENT: "glm", HUB: "http://127.0.0.1:1",
    MACHINE_LABEL: "netcup", bootVersion: "test", log: () => {},
    process: { pid: 123 },
  });
  runInContext(`${helper}\nglobalThis.telemetry = telemetry;`, context);
  assert.equal(shipped.length, 1, "boot ships once, and the boot row it wrote is never itself shipped");
  context.telemetry(turnRow(4));
  assert.equal(shipped.length, 2, "a turn row ships");
  const lines = fs.readFileSync(join(LOGDIR, "glm-5-trantor.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].boot, true);
  assert.ok(!lines[0].id, "the boot row is unchanged");
  assert.equal(lines[1].id, turnRowId("glm-5", "trantor", lines[1].ts, 4));
  assert.equal(lines[1].v, 1);
  assert.equal(lines[1].machine, "netcup");
  assert.deepEqual({ persona: shipped[1].persona, project: shipped[1].project, hub: shipped[1].hub },
    { persona: "glm-5", project: "trantor", hub: "http://127.0.0.1:1" });
});

test("a seat is read from the rows, not the filename — and telemetryFiles lists the logs", async t => {
  const bus = busFor(t);
  const hub = await startStubHub();
  t.after(() => hub.stop());
  writeLog(join(bus, "logs", "glm-5-trantor.jsonl"), [turnRow(1)]);
  assert.deepEqual(telemetryFiles(), ["glm-5-trantor.jsonl"]);
  assert.deepEqual(seatForTelemetryFile(join(bus, "logs", "glm-5-trantor.jsonl")), { persona: "glm-5", project: "trantor" });
  fs.writeFileSync(join(bus, "logs", "orphan.jsonl"), "not json\n");
  assert.equal(seatForTelemetryFile(join(bus, "logs", "orphan.jsonl")), null);
});

test("trantor telemetry ship --all ships every log and a re-run comes back as duplicates", async t => {
  const bus = busFor(t);
  const hub = await startStubHub();
  t.after(() => hub.stop());
  const logs = join(bus, "logs");
  writeLog(join(logs, "glm-5-trantor.jsonl"), [
    { ts: 1700000000000, persona: "glm-5", agent: "glm", project: "trantor", boot: true },
    turnRow(1), turnRow(2),
  ]);
  writeLog(join(logs, "kimi-trantor.jsonl"), [turnRow(1, { persona: "kimi", agent: "kimi" })]);
  fs.writeFileSync(join(logs, ".shipped-glm-5-trantor.down"), "1");
  // Async spawn, never spawnSync: the stub hub lives in THIS process, and spawnSync would freeze
  // its event loop for the whole child run.
  const run = () => new Promise(resolve => {
    const child = spawn(process.execPath, [join(ROOT, "bin/cli.mjs"), "telemetry", "ship", "--all"],
      { env: { ...process.env, AGENT_BUS_DIR: bus, RELAY_URL: hub.base }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", c => { out += c; });
    child.stderr.on("data", c => { err += c; });
    child.on("exit", c => resolve({ status: c ?? 0, stdout: out, stderr: err }));
  });
  const first = await run();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /glm-5-trantor: stored 2 · duplicates 0 · dropped 0/);
  assert.match(first.stdout, /kimi-trantor: stored 1 · duplicates 0 · dropped 0/);
  assert.ok(!fs.existsSync(join(logs, ".shipped-glm-5-trantor.down")), "a fresh process lifts the episode marker on success");
  const again = await run();
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /glm-5-trantor: stored 0 · duplicates 2/);
  assert.match(again.stdout, /kimi-trantor: stored 0 · duplicates 1/);
});

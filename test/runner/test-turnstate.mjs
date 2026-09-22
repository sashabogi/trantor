#!/usr/bin/env node
// #7749 drill: the live turn-state file across a turn's whole life. Part A runs the PRODUCTION
// runTurn (vm-extracted, like test-turn-box) against a fake CLI — the CLI reads its own file
// mid-turn (working), a stall-marker cut leaves "stalled", a clean landing "idle". Part B spawns
// the REAL turn-watchdog against a seeded file: liveness timestamps rise, phase stays the runner's.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { drillEnv } from "../drill-env.mjs";
import * as classify from "../../lib/classify-failure.mjs";
import { redactKeys } from "../../lib/redact.mjs";
import { parseTurnTokens } from "../../lib/turn-policy.mjs";
import { readTurnStateFile, refreshTurnLiveness, writeTurnState, writeTurnStateFile } from "../../lib/turnstate.mjs";
import { withEnvFiles } from "../../lib/project.mjs";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const source = fs.readFileSync(join(ROOT, "bin/crew-runner.mjs"), "utf8");
const turnSource = source.slice(source.indexOf("async function runTurn("), source.indexOf("\n// What the NEXT state step"))
  .replaceAll("import.meta.dirname", JSON.stringify(join(ROOT, "bin")));
const kimiSource = source.match(/kimi:\s*({ first:[\s\S]*?sid:.*? }),/)[1];
const outputDir = join(ROOT, ".agent-bus-out");
fs.mkdirSync(outputDir, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const TS_FILE = "turnstate-kimi-ts-drill.json";
const STALL_FILE = "turnstall-kimi-ts-drill";

// The production runTurn, aimed at a throwaway bus dir. cliBody is the fake CLI; it runs while
// the turn-state file says "working" (the runner writes that boundary BEFORE the spawn).
async function drill(t, { maxMs, cliBody }) {
  const work = fs.mkdtempSync(join(outputDir, "turnstate-"));
  const bus = join(work, ".agent-bus");
  const bin = join(work, "bin");
  fs.mkdirSync(bus);
  fs.mkdirSync(bin);
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  fs.writeFileSync(join(bin, "kimi"), cliBody, { mode: 0o755 });
  const rows = [], logs = [];
  const record = (...args) => logs.push(args.join(" "));
  const context = createContext({
    ...fs, ...classify, join, redactKeys, parseTurnTokens, withEnvFiles, setTimeout,
    // #7749: the real turn-state writer, aimed at the drill's bus dir — not the live ~/.agent-bus.
    writeTurnState: (agent, proj, patch) => writeTurnState(agent, proj, patch, bus),
    process: { env: drillEnv({ HOME: work, PATH: `${bin}:${process.env.PATH}` }), execPath: process.execPath },
    homedir: () => work, gitOut: () => "unchanged-head", registerStatus: record,
    latestBusEventId: async () => 0, busActivitySince: async () => false,
    banner: record, log: record, cmuxStatus: record, herdrAgent: record, killWatchdog: record,
    spawn: () => ({ unref: record }), telemetry: row => rows.push(row),
    spawnSync: (cmd, args, opts) => spawnSync(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] }),
    AGENT: "kimi", PROJ: "ts-drill", SESSION: "kimi:ts-drill", HUB: "http://127.0.0.1:1",
    EFFORT: null, EFFORT_FLAG: { flag: "", text: "" },
    TURN_DIR: work, ERRF: join(work, "err.txt"), TRANSCRIPT_DIR: work, RUNNER_ID: "drill",
    MODEL: "", STATE_SCHEMA_FILE: "", TURN_MAX_MS: maxMs, TURN: 0, sid: "", inFollowUp: true,
    sessionCard: 7749,
  });
  runInContext(`const cli = ${kimiSource};\n${turnSource}`, context);
  await runInContext('runTurn("finish this drill", true)', context);
  return { rows, context, bus, work, logs };
}

test("mid-turn the file reads working with the card bound; a clean end flips it to idle", async t => {
  // The fake CLI captures its OWN turn-state file mid-turn — what seat-why would see right now.
  const r = await drill(t, {
    maxMs: 10000,
    cliBody: `#!/bin/sh
echo 'To resume this session: kimi -r ts-drill-session'
echo 'turn work complete: the drill card is finished, the turn-state file was captured mid-turn'
echo 'reading working with the card bound, and the clean landing flips the phase to idle so'
echo 'seat-why and the peers row stop inferring liveness from ledger rows (#7749).'
cat "$HOME/.agent-bus/${TS_FILE}" > "$HOME/midturn-capture.json"
/bin/sleep 0.2
`,
  });
  assert.equal(r.rows[0].outcome, "completed");
  const after = readTurnStateFile(join(r.bus, TS_FILE));
  assert.equal(after.phase, "idle", `clean end must read idle, got ${after.phase}`);
  const mid = JSON.parse(fs.readFileSync(join(r.work, "midturn-capture.json"), "utf8"));
  assert.equal(mid.phase, "working", `mid-turn must read working, got ${mid.phase}`);
  assert.equal(mid.card, 7749, "the turn's card rides the working write");
  assert.equal(mid.turn, 1, "runTurn numbers the turn at its start");
  assert.equal(mid.lastBytesAt, mid.since, "lastBytesAt is armed at the turn's start");
});

test("a stall-marker cut leaves the file reading stalled", async t => {
  // The CLI writes the watchdog's stall marker and goes silent; the box sweeps at the marker,
  // so the runner's post-turn boundary write is the STALLED phase, not a generic cut.
  const r = await drill(t, {
    maxMs: 15000,
    cliBody: `#!/bin/sh
echo 'To resume this session: kimi -r ts-drill-session'
: > "$HOME/.agent-bus/${STALL_FILE}"
exec /bin/sleep 30
`,
  });
  assert.equal(r.rows[0].outcome, "stalled", JSON.stringify(r.rows[0]));
  assert.equal(r.rows[0].stalled, true);
  const after = readTurnStateFile(join(r.bus, TS_FILE));
  assert.equal(after.phase, "stalled", `stall cut must read stalled, got ${after.phase}`);
  assert.equal(after.card, 7749, "the stalled write merges over the working write — card survives");
});

test("the real watchdog moves lastBytesAt/lastTranscriptAt mid-turn and never touches phase", async t => {
  const work = fs.mkdtempSync(join(outputDir, "turnstate-wd-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const stampF = join(work, "stamp.json"), errF = join(work, "err.txt");
  const tsF = join(work, TS_FILE), stallF = join(work, STALL_FILE);
  const trDir = join(work, "transcripts"), wkDir = join(work, "worktree");
  fs.mkdirSync(trDir); fs.mkdirSync(wkDir);
  const t0 = Date.now();
  fs.writeFileSync(stampF, JSON.stringify({ turn: 7, startedAt: t0 }));
  fs.writeFileSync(errF, "");
  writeTurnStateFile(tsF, { turn: 7, phase: "working", since: t0, card: 7749, lastBytesAt: 1000, lastTranscriptAt: 0 });
  // Kill mode with a tiny window: poll 300ms, stall after ~1.2s of silence on every channel.
  const wd = spawn(process.execPath, [join(ROOT, "bin/turn-watchdog.mjs"),
    stampF, errF, "1200", "kimi:ts-drill", "ts-drill", "http://127.0.0.1:1", trDir, wkDir, stallF, tsF],
    { env: drillEnv({ HOME: work }), stdio: "ignore" });
  t.after(() => { try { wd.kill("SIGKILL"); } catch {} });

  // Active phase: bytes on stderr and a transcript write every ~220ms for ~2.5s.
  const bytesSamples = new Set();
  let transcriptAt = 0;
  const stopAt = Date.now() + 2500;
  while (Date.now() < stopAt) {
    fs.appendFileSync(errF, `${"x".repeat(40)}\n`);
    fs.appendFileSync(join(trDir, "t.jsonl"), `{"ts":${Date.now()}}\n`);
    await sleep(220);
    const s = readTurnStateFile(tsF);
    if (s && s.lastBytesAt > 1000) bytesSamples.add(s.lastBytesAt);
    if (s && s.lastTranscriptAt > 0) transcriptAt = s.lastTranscriptAt;
  }
  assert.ok(bytesSamples.size >= 2, `lastBytesAt must RISE with new output, saw [${[...bytesSamples]}]`);
  assert.ok(transcriptAt >= t0, `lastTranscriptAt must follow the transcript, got ${transcriptAt}`);
  assert.equal(readTurnStateFile(tsF).phase, "working", "the watchdog never writes phase");

  // Silent phase: every channel quiet — the watchdog writes the stall marker and exits.
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline && !fs.existsSync(stallF)) await sleep(200);
  assert.ok(fs.existsSync(stallF), "a silent turn earns the stall marker inside the window");
  await new Promise(res => { if (wd.exitCode !== null) res(); else { wd.once("exit", res); setTimeout(res, 5000); } });
  assert.equal(readTurnStateFile(tsF).phase, "working",
    "even at the stall the file still reads working — the runner's post-turn write owns 'stalled'");
});

test("refreshTurnLiveness refuses a turn or phase that has moved on", async t => {
  const work = fs.mkdtempSync(join(outputDir, "turnstate-unit-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const p = join(work, "ts.json");
  writeTurnStateFile(p, { turn: 1, phase: "idle", since: 1 });
  assert.equal(refreshTurnLiveness(p, { turn: 1, bytesAt: 5 }), false, "an idle turn takes no liveness");
  writeTurnStateFile(p, { turn: 1, phase: "working", since: 1, card: 9 });
  assert.equal(refreshTurnLiveness(p, { turn: 2, bytesAt: 5 }), false, "a newer turn's refresh must not resurrect the old one");
  assert.equal(refreshTurnLiveness(p, { turn: 1, bytesAt: 5 }), true);
  assert.deepEqual(readTurnStateFile(p), { turn: 1, phase: "working", since: 1, card: 9, lastBytesAt: 5 },
    "the refresh merges — it never drops the runner's fields");
  assert.equal(readTurnStateFile(join(work, "missing.json")), null);
  fs.writeFileSync(p, "not json{");
  assert.equal(readTurnStateFile(p), null, "a torn file reads as absent, never as a lie");
});

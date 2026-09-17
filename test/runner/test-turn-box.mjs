#!/usr/bin/env node
// #7742: execute the production runTurn with a real bash/CLI/stdio pipe; stub only hub/UI/watchdog I/O.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { drillEnv } from "../drill-env.mjs";
import * as classify from "../../lib/classify-failure.mjs";
import { redactKeys } from "../../lib/redact.mjs";
import { parseTurnTokens } from "../../lib/turn-policy.mjs";
import { withEnvFiles } from "../../lib/project.mjs";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const source = fs.readFileSync(join(ROOT, "bin/crew-runner.mjs"), "utf8");
const turnSource = source.slice(source.indexOf("async function runTurn("), source.indexOf("\n// What the NEXT state step"))
  .replaceAll("import.meta.dirname", JSON.stringify(join(ROOT, "bin")));
const kimiSource = source.match(/kimi:\s*({ first:[\s\S]*?sid:.*? }),/)[1];
const outputDir = join(ROOT, ".agent-bus-out");
fs.mkdirSync(outputDir, { recursive: true });

async function drill(t, maxMs, slow = false, inheritBoxOutput = false) {
  const work = fs.mkdtempSync(join(outputDir, "turn-box-"));
  const bus = join(work, ".agent-bus");
  const bin = join(work, "bin");
  fs.mkdirSync(bus);
  fs.mkdirSync(bin);
  const sleepFile = join(work, "sleep.pid");
  t.after(() => {
    if (fs.existsSync(sleepFile)) {
      const pid = Number(fs.readFileSync(sleepFile, "utf8").trim());
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    fs.rmSync(work, { recursive: true, force: true });
  });
  fs.writeFileSync(join(bin, "sleep"), `#!/bin/sh
echo $$ > "${sleepFile}"
exec /bin/sleep "$@"
`, { mode: 0o755 });
  fs.writeFileSync(join(bin, "kimi"), `#!/bin/sh
echo 'To resume this session: kimi -r box-drill-session'
echo 'turn work complete: the drill card is finished, the box sleep was reaped, the session id'
echo 'was captured from the resume line, and the telemetry row records a completed turn, so'
echo 'the runner can move on to its next wake without a redelivery ladder or a park (#7759).'
/bin/sleep ${slow ? 30 : 0.2}
`, { mode: 0o755 });
  const rows = [], logs = [];
  let sawMarker = false, spawnResult;
  const record = (...args) => logs.push(args.join(" "));
  const context = createContext({
    ...fs, ...classify, join, redactKeys, parseTurnTokens, withEnvFiles, setTimeout,
    process: { env: drillEnv({ HOME: work, PATH: `${bin}:${process.env.PATH}` }), execPath: process.execPath },
    homedir: () => work, gitOut: () => "unchanged-head", registerStatus: record,
    // #7759 helpers, stubbed like gitOut: no hub in this sandbox, so bus activity reads as none.
    latestBusEventId: async () => 0, busActivitySince: async () => false,
    banner: record, log: record, cmuxStatus: record, herdrAgent: record, killWatchdog: record,
    spawn: () => ({ unref: record }), telemetry: row => rows.push(row),
    spawnSync: (cmd, args, opts) => {
      assert.deepEqual(Array.from(opts.stdio), ["ignore", "pipe", "inherit"]);
      spawnResult = spawnSync(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
      return spawnResult;
    },
    existsSync: path => {
      const exists = fs.existsSync(path);
      if (path === join(bus, "turncut-kimi-box-drill") && exists) sawMarker = true;
      return exists;
    },
    AGENT: "kimi", PROJ: "box-drill", SESSION: "kimi:box-drill", HUB: "http://127.0.0.1:1",
    // module consts the extracted runTurn reads (#7777): this sandbox launches with no CREW_EFFORT,
    // so the effort record is null and its flag renders as the empty string — byte-identical command.
    EFFORT: null, EFFORT_FLAG: { flag: "", text: "" },
    TURN_DIR: work, ERRF: join(work, "err.txt"), TRANSCRIPT_DIR: work, RUNNER_ID: "drill",
    MODEL: "", STATE_SCHEMA_FILE: "", TURN_MAX_MS: maxMs, TURN: 0, sid: "", inFollowUp: true,
  });
  runInContext(`const cli = ${kimiSource};\n${inheritBoxOutput ? turnSource.replace(") >/dev/null 2>&1 & boxpid", ") & boxpid") : turnSource}`, context);
  await runInContext('runTurn("finish this drill", true)', context);
  return { rows, context, spawnResult, sawMarker, sleepFile, logs };
}

for (const inheritOutput of [false, true]) {
  test(`fast sid turn finishes and reaps the box sleep (box output inherited: ${inheritOutput})`, async t => {
    const r = await drill(t, 10000, false, inheritOutput);
    assert.equal(r.spawnResult.status, 0);
    assert.equal(r.context.sid, "box-drill-session");
    assert.equal(r.rows[0].outcome, "completed");
    assert.ok(r.rows[0].duration_ms < 4000, `turn took ${r.rows[0].duration_ms}ms with a 10s box`);
    assert.equal(r.sawMarker, false);
    const pid = Number(fs.readFileSync(r.sleepFile, "utf8").trim());
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
}

test("a real box cut writes the marker and records a cut outcome", async t => {
  const r = await drill(t, 1000, true);
  assert.equal(r.sawMarker, true);
  assert.equal(r.rows[0].outcome, "cut");
  assert.equal(r.rows[0].cut, true);
  assert.equal(r.context.lastTurnCut, true);
  assert.ok(r.rows[0].duration_ms < 5000);
  assert.equal(r.spawnResult.error, undefined);
});

test("a disabled box still captures the sid without creating a timer", async t => {
  const r = await drill(t, 0);
  assert.equal(r.context.sid, "box-drill-session");
  assert.equal(r.rows[0].outcome, "completed");
  assert.equal(r.sawMarker, false);
  assert.equal(fs.existsSync(r.sleepFile), false);
});

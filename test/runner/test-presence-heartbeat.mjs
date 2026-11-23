#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { drillEnv } from "../drill-env.mjs";
import { startTestHub } from "../lib/test-hub.mjs";
import * as classify from "../../lib/classify-failure.mjs";
import { redactKeys } from "../../lib/redact.mjs";
import { parseTurnTokens } from "../../lib/turn-policy.mjs";
import { writeTurnState } from "../../lib/turnstate.mjs";
import { withEnvFiles } from "../../lib/project.mjs";
import { seatSignalPrefix } from "../../lib/seat-signal-guard.mjs";
import { shadowEnv, withSecretExports } from "../../lib/secrets.mjs";
import { afterTurn } from "../../lib/burn-guard.mjs";
import { snapshotBeforeCut } from "../../bin/cut-snapshot.mjs";
import { newContainers, recordContainers } from "../../lib/docker-janitor.mjs";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const source = fs.readFileSync(join(ROOT, "bin/crew-runner.mjs"), "utf8");
const turnSource = source.slice(source.indexOf("async function runTurn("), source.indexOf("\n// What the NEXT state step"))
  .replaceAll("import.meta.dirname", JSON.stringify(join(ROOT, "bin")));
const kimiSource = source.match(/kimi:\s*({ first:[\s\S]*?sid:.*? }),/)[1];
const outputDir = join(ROOT, ".agent-bus-out");
fs.mkdirSync(outputDir, { recursive: true });

test("a working turn stays online beyond the hub's online window", async t => {
  const work = fs.mkdtempSync(join(outputDir, "presence-heartbeat-"));
  const bus = join(work, ".agent-bus"), bin = join(work, "bin");
  const capture = join(work, "midturn-peer.json");
  const session = "kimi:presence-drill";
  fs.mkdirSync(bus);
  fs.mkdirSync(bin);
  const hub = await startTestHub({ env: { RELAY_ONLINE_MS: "600", RELAY_PEER_TTL_MS: "10000" } });
  let watchdog;
  t.after(async () => {
    try { watchdog?.kill("SIGKILL"); } catch {}
    await hub.stop();
    fs.rmSync(work, { recursive: true, force: true });
  });
  fs.writeFileSync(join(bin, "kimi"), `#!/bin/sh
echo 'To resume this session: kimi -r presence-drill-session'
node --input-type=module -e '
import { writeFileSync } from "node:fs";
await new Promise(resolve => setTimeout(resolve, 1200));
const response = await fetch(process.env.TRANTOR_TEST_HUB + "/peers");
const body = await response.json();
writeFileSync(process.env.TRANTOR_TEST_CAPTURE, JSON.stringify(body.peers.find(peer => peer.session === process.env.TRANTOR_TEST_SESSION)));
'
echo 'the long turn is still working and its presence must remain online past the hub window'
`, { mode: 0o755 });

  const env = drillEnv({
    HOME: work,
    PATH: `${bin}:${process.env.PATH}`,
    RUNNER_PRESENCE_MS: "150",
    RELAY_URL: hub.base,
    RELAY_SESSION: session,
    RELAY_PROJECT: "presence-drill",
    TRANTOR_TEST_HUB: hub.base,
    TRANTOR_TEST_CAPTURE: capture,
    TRANTOR_TEST_SESSION: session,
  });
  const logs = [];
  const record = (...args) => logs.push(args.join(" "));
  const context = createContext({
    ...fs, ...classify, join, redactKeys, parseTurnTokens, withEnvFiles, seatSignalPrefix, setTimeout,
    shadowEnv, withSecretExports, resolveSecrets: () => ({}),
    writeTurnState: (agent, proj, patch) => writeTurnState(agent, proj, patch, bus),
    process: { env, execPath: process.execPath },
    homedir: () => work,
    gitOut: () => "unchanged-head",
    registerStatus: async (status, extra = {}) => {
      await fetch(`${hub.base}/register`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ session, project: "presence-drill", status, persona: "kimi", agent: "kimi", llm: "kimi", ...extra }) });
    },
    latestBusEventId: async () => 0,
    busActivitySince: async () => false,
    busMessagesSince: async () => [],
    turnDelivered: () => false,
    listContainers: () => null,
    newContainers, recordContainers, snapshotBeforeCut,
    OC_DB: join(work, "absent-opencode.db"),
    banner: record, log: record, cmuxStatus: record, herdrAgent: record,
    killWatchdog: () => { try { watchdog?.kill("SIGTERM"); } catch {} },
    spawn: (cmd, args, opts) => {
      const child = spawn(cmd, args, { ...opts, env, stdio: ["ignore", "ignore", "inherit"] });
      if (args[0]?.endsWith("turn-watchdog.mjs")) watchdog = child;
      return child;
    },
    telemetry: record,
    spawnSync,
    AGENT: "kimi", PERSONA: "kimi", PROJ: "presence-drill", SESSION: session, HUB: hub.base,
    EFFORT: null, EFFORT_FLAG: { flag: "", text: "" },
    TURN_DIR: work, ERRF: join(work, "err.txt"), TRANSCRIPT_DIR: work, RUNNER_ID: "drill",
    MODEL: "", STATE_SCHEMA_FILE: "", TURN_MAX_MS: 10000, TURN: 0, sid: "", inFollowUp: true,
    PRESENCE_MS: 150, MACHINE_LABEL: "", sessionCard: 13939,
    // #13923: runTurn exports the seat-instance stamp into the turn shell.
    BOOT_TS: Date.now(),
    seatBuildCacheEnv: (env) => env,   // #12270: the shared-cache env is the runner's; identity here
    TURN_CEILING_MS: 0, TURN_EXTEND_MS: 0, TURN_EXTENSIONS_MAX: 0,
    cutChain: [], cardTokens: 0, cardCommits: 0, afterTurn, saveWipLogged: record,
    CAPCFG: { cap: 0 }, capFreshTurn: 0,
    DRIVER: "kimi", effortForTurn: () => ({ flag: "", text: "", changed: false }),
  });
  runInContext(`const cli = ${kimiSource};\n${turnSource}`, context);
  await runInContext('runTurn("hold a long working turn", true)', context);

  const peer = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.equal(peer.online, true, `mid-turn peer must remain online: ${JSON.stringify(peer)}`);
  assert.equal(peer.phase, "working");
  assert.match(peer.status, /^working/);
  const ended = (await (await fetch(`${hub.base}/peers`)).json()).peers.find(row => row.session === session);
  assert.equal(ended.phase, "idle");
  await new Promise(resolve => setTimeout(resolve, 500));
  const later = (await (await fetch(`${hub.base}/peers`)).json()).peers.find(row => row.session === session);
  assert.equal(later.lastSeen, ended.lastSeen, "the heartbeat must stop when the turn ends");
});

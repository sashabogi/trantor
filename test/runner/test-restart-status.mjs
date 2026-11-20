#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "../drill-env.mjs";
import { startTestHub } from "../lib/test-hub.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "trantor-restart-status-"));
const project = "restart-status";
const session = `codex:${project}`;
const hub = await startTestHub({ dir: join(home, "hub") });
let runner;
let stderr = "";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const get = async path => (await fetch(hub.base + path)).json();
const waitFor = async (check, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  return null;
};

try {
  runner = spawn(process.execPath, [join(ROOT, "bin/crew-runner.mjs"), "codex", home], {
    cwd: ROOT,
    env: drillEnv({
      HOME: home,
      RELAY_URL: hub.base,
      RELAY_PROJECT: project,
      RELAY_AGENT: "codex",
      CREW_RELEASE_STATE: JSON.stringify({ cursor: 0, turn: 4, lastTurnAt: Date.now() }),
      TRANTOR_NO_UPDATE_CHECK: "1",
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  runner.stderr.on("data", chunk => { stderr += chunk; });

  const ready = await waitFor(async () => {
    const { messages } = await get("/recent?limit=100");
    return messages.some(message => message.from === session && message.text.includes("ready for a contract"));
  });
  assert.ok(ready, `runner never broadcast ready: ${stderr}`);

  const peer = await waitFor(async () => {
    const { peers } = await get(`/peers?project=${project}`);
    const current = peers.find(candidate => candidate.session === session);
    return current?.status === "idle" && current?.phase === "idle" ? current : null;
  });
  const { peers } = await get(`/peers?project=${project}`);
  const current = peers.find(candidate => candidate.session === session);
  assert.ok(peer, `restarted runner remained ${JSON.stringify(current)}: ${stderr}`);
  assert.equal(current.phaseSince > 0, true);
  console.log("PASS restarted idle runner reports idle status and phase on /peers");
} finally {
  if (runner && runner.exitCode === null && runner.signalCode === null) {
    runner.kill("SIGKILL");
    await new Promise(resolve => runner.once("exit", resolve));
  }
  await hub.stop();
  rmSync(home, { recursive: true, force: true });
}

#!/usr/bin/env node
// Stop-hook stalled-contract episode drill. The fake hub and bus dir are isolated; no live
// contracts, inbox cursors, keys, or project configuration are touched.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "./drill-env.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "trantor-stop-stalled-"));
const bus = join(work, "bus");
const repo = join(work, "repo");
mkdirSync(bus, { recursive: true });
mkdirSync(repo, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = "") => {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  condition ? pass++ : fail++;
};

let contracts = [];
const hub = http.createServer((req, res) => {
  const reply = (body) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const path = new URL(req.url, "http://test").pathname;
  req.resume();
  if (path === "/contracts") return reply({ contracts });
  if (path === "/inbox") return reply({ messages: [], cursor: 0 });
  if (path === "/enroll") return reply({ ok: true });
  return reply({ ok: true });
});
await new Promise(resolve => hub.listen(0, "127.0.0.1", resolve));
const relayUrl = `http://127.0.0.1:${hub.address().port}`;
const session = "host:stop-seen";
const seenFile = join(bus, "stop-stalled-seen-host_stop-seen.json");

function stalled(id, text) {
  return {
    id, text, to: "dead:stop-seen", disposition: "stalled", answered: false,
    assigneeOnline: false, assigneeLastSeenMs: 90_000, ageMs: 120_000,
  };
}

function runStop() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, "hooks", "stop-inbox.mjs")], {
      cwd: ROOT,
      env: {
        ...drillEnv(),
        AGENT_BUS_DIR: bus,
        CLAUDE_PROJECT_DIR: repo,
        RELAY_URL: relayUrl,
        RELAY_SESSION: session,
        RELAY_PROJECT: "stop-seen",
        RELAY_STOP_TIMEOUT_MS: "1000",
        TRANTOR_CONTRACT_OVERDUE_MS: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      let output = {};
      try { output = JSON.parse(stdout || "{}"); } catch {}
      resolve({ code, output, stdout, stderr });
    });
    child.stdin.end(JSON.stringify({ session_id: "stop-seen-instance", cwd: repo, stop_hook_active: false }));
  });
}

try {
  console.log("# stop hook stalled-contract seen-set");

  contracts = [stalled(101, "first stalled contract")];
  const first = await runStop();
  ok("a missing seen file treats the stalled id as new", first.output.decision === "block");
  ok("the new stalled id is persisted before blocking", JSON.parse(readFileSync(seenFile, "utf8")).includes("101"));

  const repeat = await runStop();
  const repeatLines = repeat.stderr.trim().split("\n").filter(Boolean);
  ok("the same stalled id does not block a second Stop", repeat.output.decision !== "block");
  ok("a repeated id emits exactly one diagnostic line", repeatLines.length === 1, repeat.stderr.trim());

  contracts = [stalled(101, "first stalled contract"), stalled(202, "new stalled contract")];
  const next = await runStop();
  ok("a different stalled id starts a new episode and blocks", next.output.decision === "block");
  ok("the reason identifies the new contract, not the already-seen one",
    /new stalled contract/.test(next.output.reason || "") && !/first stalled contract/.test(next.output.reason || ""));

  writeFileSync(seenFile, "{not-json");
  contracts = [stalled(303, "after corrupt seen file")];
  const corrupt = await runStop();
  ok("a corrupt seen file recovers as an empty set and blocks on the current id", corrupt.output.decision === "block");
  ok("the corrupt file is replaced with valid persisted state", JSON.parse(readFileSync(seenFile, "utf8")).includes("303"));

  const afterCorrupt = await runStop();
  ok("the recovered id is quiet on the following Stop", afterCorrupt.output.decision !== "block");
  ok("the recovered repeat also emits one diagnostic line",
    afterCorrupt.stderr.trim().split("\n").filter(Boolean).length === 1, afterCorrupt.stderr.trim());
} catch (error) {
  fail++;
  console.log(`  FAIL  harness error — ${error?.stack || error}`);
} finally {
  await new Promise(resolve => hub.close(resolve));
  rmSync(work, { recursive: true, force: true });
}

console.log(`\nstop stalled drills: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

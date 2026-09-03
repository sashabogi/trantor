#!/usr/bin/env node
// Regression drill for the 2026-09-02 stale-snapshot restart: a runner retained cursor 500 while
// the restored hub's message tip was 200, so every poll heartbeat succeeded but no work arrived.
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = "") => {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}${condition || !detail ? "" : ` — ${detail}`}`);
  if (condition) pass += 1; else fail += 1;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(error => error ? reject(error) : resolve(port));
  });
});
const waitFor = async (check, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch {}
    await sleep(30);
  }
  return null;
};
const stop = child => new Promise(resolve => {
  if (!child || child.exitCode !== null) return resolve();
  child.once("exit", resolve);
  child.kill("SIGTERM");
});

console.log("# hub cursor rewind clamp");
const scratch = mkdtempSync(join(tmpdir(), "trantor-cursor-rewind-"));
const children = new Set();
try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const statePath = join(scratch, "state.json");
  writeFileSync(statePath, JSON.stringify({
    seq: 200,
    messages: [{ id: 200, ts: Date.now(), from: "seed:p", to: "other:p", text: "tip", project: "p" }],
  }));
  let hub = spawn(process.execPath, ["hub.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: scratch, RELAY_PORT: String(port), RELAY_HOST: "127.0.0.1", RELAY_AUTH: "off", RELAY_STORE: "json", RELAY_DATA_DIR: scratch, RELAY_STATE: statePath },
    stdio: "ignore",
  });
  children.add(hub); hub.once("exit", () => children.delete(hub));
  await waitFor(async () => (await fetch(base + "/health")).ok);

  const inbox = await fetch(base + "/inbox?session=runner:p&since=500").then(response => response.json());
  ok("/inbox clamps an impossible cursor to the current tip", inbox.cursor === 200 && inbox.rewound === true && inbox.messages.length === 0, JSON.stringify(inbox));

  const pollStarted = Date.now();
  const poll = await fetch(base + "/poll?session=runner:p&since=500&wait=5").then(response => response.json());
  ok("/poll reports the rewind immediately instead of waiting", poll.cursor === 200 && poll.rewound === true && Date.now() - pollStarted < 1000, JSON.stringify(poll));

  const sent = await fetch(base + "/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "host:p", to: "runner:p", text: "next contract" }) }).then(response => response.json());
  const next = await fetch(base + "/inbox?session=runner:p&since=200").then(response => response.json());
  ok("the first message after the restored tip is delivered", sent.id === 201 && next.cursor === 201 && next.messages[0]?.text === "next contract" && !next.rewound, JSON.stringify(next));
  await stop(hub);

  console.log("# crew runner adopts the lower cursor");
  const pollSince = [];
  let pollCount = 0;
  const runnerProject = "cursor-drill";
  const runnerSession = `codex:${runnerProject}`;
  const mockHub = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const url = new URL(request.url, "http://x");
      const reply = value => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (url.pathname === "/health") return reply({ ok: true, authMode: "off" });
      if (url.pathname === "/lessons") return reply({ lessons: [] });
      if (url.pathname === "/inbox") return reply({ messages: [], cursor: 500 });
      if (url.pathname === "/poll") {
        const since = Number(url.searchParams.get("since") || 0);
        pollSince.push(since);
        pollCount += 1;
        if (pollCount === 1) return reply({ messages: [], cursor: 200, rewound: true });
        if (pollCount === 2) return reply({ messages: [{ id: 201, ts: Date.now(), from: "host:cursor-drill", to: runnerSession, project: runnerProject, text: "contract: handle the next message" }], cursor: 201 });
        return setTimeout(() => reply({ messages: [], cursor: 201 }), 100);
      }
      return reply({ ok: true, id: 900 + pollCount });
    });
  });
  await new Promise(resolve => mockHub.listen(0, "127.0.0.1", resolve));

  const work = join(scratch, "runner-work");
  const home = join(scratch, "runner-home");
  const fakeBin = join(scratch, "fake-bin");
  const turnsPath = join(scratch, "turns.log");
  mkdirSync(work); mkdirSync(join(home, ".agent-bus"), { recursive: true }); mkdirSync(fakeBin);
  const fakeCodex = join(fakeBin, "codex");
  writeFileSync(fakeCodex, `#!/bin/bash\nprintf '%s\\n' '===TURN===' >> '${turnsPath}'\ncat "$HOME/.agent-bus/turn-codex-${runnerProject}.txt" >> '${turnsPath}'\nprintf '%s\\n' 'runner cursor drill complete'\n`);
  chmodSync(fakeCodex, 0o755);
  let runnerOutput = "";
  const runner = spawn(process.execPath, ["bin/crew-runner.mjs", "codex", work], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}`, RELAY_URL: `http://127.0.0.1:${mockHub.address().port}`, RELAY_AGENT: "codex", RELAY_PROJECT: runnerProject, TRANTOR_NO_WORKTREE: "1", CREW_KICKOFF: "finish kickoff" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(runner); runner.once("exit", () => children.delete(runner));
  runner.stdout.setEncoding("utf8"); runner.stderr.setEncoding("utf8");
  runner.stdout.on("data", chunk => { runnerOutput += chunk; });
  runner.stderr.on("data", chunk => { runnerOutput += chunk; });
  const delivered = await waitFor(() => existsSync(turnsPath) && readFileSync(turnsPath, "utf8").includes("handle the next message"));
  await stop(runner);
  await new Promise(resolve => mockHub.close(resolve));
  ok("runner logs one explicit rewind transition", (runnerOutput.match(/cursor rewound by hub 500 -> 200/g) || []).length === 1, runnerOutput.slice(-500));
  ok("runner's next poll uses the adopted lower cursor", pollSince[0] === 500 && pollSince[1] === 200, pollSince.join(","));
  ok("message 201 wakes the runner after rewind recovery", !!delivered);
} finally {
  for (const child of children) child.kill("SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

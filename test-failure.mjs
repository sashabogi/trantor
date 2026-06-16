#!/usr/bin/env node
// trantor crew failure-visibility drill — proves a failed crew turn is surfaced to the bus
// in real time (the orchestrator was previously blind: the runner swallowed the exit code).
// Hermetic: a mock recording hub (never touches the real ~/.agent-bus/bus.json) + a fake CLI
// that fails like an exhausted account. Exercises the REAL bin/crew-runner.mjs.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("# trantor crew failure-visibility drill");

// ---- mock hub: record /register + /send, answer the runner's polls -------------------
const registers = [], sends = [];
const hub = http.createServer((req, res) => {
  let buf = "";
  req.on("data", (c) => (buf += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    const P = u.pathname;
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "POST" && P === "/register") { try { registers.push(JSON.parse(buf)); } catch {} return reply({ ok: true, session: "x", peers: [] }); }
    if (req.method === "POST" && P === "/send") { try { sends.push(JSON.parse(buf)); } catch {} return reply({ ok: true, id: sends.length }); }
    if (P === "/inbox") return reply({ messages: [], cursor: 0 });
    if (P === "/lessons") return reply({ lessons: [] });
    if (P === "/poll") return setTimeout(() => reply({ messages: [], cursor: 0 }), 200);
    return reply({ ok: true });
  });
});
await new Promise((r) => hub.listen(0, "127.0.0.1", r));
const PORT = hub.address().port;
const HUB = `http://127.0.0.1:${PORT}`;

// ---- a fake `codex` that fails like an exhausted account -----------------------------
const work = mkdtempSync(join(tmpdir(), "tt-fail-"));
const fakebin = join(work, "bin");
mkdirSync(fakebin, { recursive: true });
const fakeCodex = join(fakebin, "codex");
writeFileSync(fakeCodex, '#!/bin/sh\necho "Error: insufficient_quota — you exceeded your current quota, please check your plan" >&2\nexit 1\n');
chmodSync(fakeCodex, 0o755);

// ---- run the REAL runner against the mock hub ----------------------------------------
const HOME = join(work, "home");
mkdirSync(join(HOME, ".agent-bus"), { recursive: true });
const runner = spawn("node", ["bin/crew-runner.mjs", "codex", work], {
  cwd: process.cwd(),
  env: { ...process.env, HOME, PATH: `${fakebin}:${process.env.PATH}`,
         RELAY_URL: HUB, RELAY_AGENT: "codex", RELAY_PROJECT: "tt-fail",
         CREW_KICKOFF: "say hi and end your turn" },
  stdio: "ignore",
});

// kickoff turn runs synchronously inside the runner; give it a moment to fail + report
await sleep(2500);
runner.kill("SIGKILL");
await sleep(150);
hub.close();

// ---- assertions ----------------------------------------------------------------------
const failMsg = sends.find((m) => /turn FAILED/i.test(m.text || ""));
ok("a failure message was posted to the bus (orchestrator is no longer blind)", !!failMsg);
ok("failure went to 'all' so the orchestrator's relay_wait sees it", failMsg && failMsg.to === "all");
ok("the exhausted account was classified (→ suggests `trantor swap`)",
   !!failMsg && /exhausted/i.test(failMsg.text) && /swap/i.test(failMsg.text));
const erroredReg = registers.find((r) => String(r.status || "").startsWith("errored"));
ok("presence flipped to an 'errored' status (board shows it, not green)", !!erroredReg);
ok("the failed turn's exit code is reported", !!failMsg && /exit 1/.test(failMsg.text));

console.log(`\nfailure drills: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

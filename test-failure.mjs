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

// ---- drill harness: a fake CLI that fails, driven by the REAL runner -----------------
// `script` is the whole body of the fake CLI, so a drill controls exactly WHICH STREAM the
// CLI complains on — the distinction that hid a real outage (see the claude drills below).
async function drill(agent, script) {
  registers.length = 0; sends.length = 0;
  const work = mkdtempSync(join(tmpdir(), `tt-fail-${agent}-`));
  const fakebin = join(work, "bin");
  mkdirSync(fakebin, { recursive: true });
  const fake = join(fakebin, agent);
  writeFileSync(fake, script);
  chmodSync(fake, 0o755);

  const HOME = join(work, "home");
  mkdirSync(join(HOME, ".agent-bus"), { recursive: true });
  const runner = spawn("node", ["bin/crew-runner.mjs", agent, work], {
    cwd: process.cwd(),
    env: { ...process.env, HOME, PATH: `${fakebin}:${process.env.PATH}`,
           RELAY_URL: HUB, RELAY_AGENT: agent, RELAY_PROJECT: `tt-fail-${agent}`,
           CREW_KICKOFF: "say hi and end your turn" },
    stdio: "ignore",
  });
  // kickoff turn runs synchronously inside the runner; give it a moment to fail + report
  await sleep(2500);
  runner.kill("SIGKILL");
  await sleep(150);
  return { registers: [...registers], sends: [...sends] };
}

// ---- drill 1: an exhausted account complaining on STDERR ------------------------------
{
  const { registers, sends } = await drill("codex",
    '#!/bin/sh\necho "Error: insufficient_quota — you exceeded your current quota, please check your plan" >&2\nexit 1\n');
  const failMsg = sends.find((m) => /turn FAILED/i.test(m.text || ""));
  ok("a failure message was posted to the bus (orchestrator is no longer blind)", !!failMsg);
  ok("failure went to 'all' so the orchestrator's relay_wait sees it", failMsg && failMsg.to === "all");
  ok("the exhausted account was classified (→ suggests `trantor swap`)",
     !!failMsg && /exhausted/i.test(failMsg.text) && /swap/i.test(failMsg.text));
  const erroredReg = registers.find((r) => String(r.status || "").startsWith("errored"));
  ok("presence flipped to an 'errored' status (board shows it, not green)", !!erroredReg);
  ok("the failed turn's exit code is reported", !!failMsg && /exit 1/.test(failMsg.text));
}

// ---- drill 2: a usage limit announced on STDOUT --------------------------------------
// Observed for real: the duty seat burned turns 414-418 on "You've reached your Fable 5 limit",
// every one reported as `crashed`. Only stderr was teed to the classifier's file, and the
// `claude` seat has no sid regex — so the CLI's own explanation never reached classifyFailure.
{
  const { sends } = await drill("claude",
    '#!/bin/sh\necho "You\'ve reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."\nexit 1\n');
  const failMsg = sends.find((m) => /turn FAILED/i.test(m.text || ""));
  ok("a stdout-only failure still reaches the bus", !!failMsg);
  ok("a usage limit on STDOUT is classified exhausted, not crashed",
     !!failMsg && /exhausted/i.test(failMsg.text) && !/crashed/i.test(failMsg.text));
  ok("an exhausted seat is told to swap", !!failMsg && /swap/i.test(failMsg.text));
}

// ---- drill 3: the limit wording alone, with no quota/credit vocabulary ----------------
// Guards the classifier itself: this text shares no word with the old pattern, so it proves
// the match is on "reached your … limit" and not on the incidental "credit" in /usage-credits.
{
  const { sends } = await drill("claude", '#!/bin/sh\necho "You\'ve reached your Opus 5 limit."\nexit 1\n');
  const failMsg = sends.find((m) => /turn FAILED/i.test(m.text || ""));
  ok("a bare subscription limit is classified exhausted", !!failMsg && /exhausted/i.test(failMsg.text));
}

hub.close();

console.log(`\nfailure drills: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

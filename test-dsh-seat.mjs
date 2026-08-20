#!/usr/bin/env node
// trantor dsh crew-seat drill — the DeepSeek Harness seat through the REAL crew-runner.
//
// dsh differs from every other seat: headless has NO resume, so every turn is a fresh session and
// the invocation is identical for kickoff and wake. These drills pin the contract: the runner
// invokes `dsh --profile trantor` with the prompt as its one positional arg, the seat env carries
// the RELAY_* identity (that is how the profile's relay MCP + hooks bridge inherit the seat's
// binding), and a failed turn is classified and reported like any other seat's.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c || !x ? "" : `\n          ${x}`}`); c ? pass++ : fail++;};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log("# trantor dsh crew-seat drill");

const registers = [], sends = [];
const hub = http.createServer((req, res) => {
  let b = ""; req.on("data", c => (b += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "POST" && u.pathname === "/register") { try { registers.push(JSON.parse(b)); } catch {} return reply({ ok: true, peers: [] }); }
    if (req.method === "POST" && u.pathname === "/send") { try { sends.push(JSON.parse(b)); } catch {} return reply({ ok: true }); }
    if (u.pathname === "/inbox") return reply({ messages: [], cursor: 0 });
    if (u.pathname === "/lessons") return reply({ lessons: [] });
    if (u.pathname === "/poll") return setTimeout(() => reply({ messages: [], cursor: 0 }), 200);
    return reply({ ok: true });
  });
});
await new Promise(r => hub.listen(0, "127.0.0.1", r));
const HUB = `http://127.0.0.1:${hub.address().port}`;

async function drill(script) {
  registers.length = 0; sends.length = 0;
  const work = mkdtempSync(join(tmpdir(), "tt-dsh-"));
  const bin = join(work, "bin"); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "dsh"), script); chmodSync(join(bin, "dsh"), 0o755);
  const HOME = join(work, "home"); mkdirSync(join(HOME, ".agent-bus"), { recursive: true });
  const runner = spawn("node", ["bin/crew-runner.mjs", "dsh", work], {
    cwd: process.cwd(), stdio: "ignore",
    env: { ...process.env, HOME, PATH: `${bin}:${process.env.PATH}`,
      RELAY_URL: HUB, RELAY_AGENT: "dsh", RELAY_PROJECT: "tt-dsh",
      CREW_KICKOFF: "kickoff: introduce yourself and end your turn" },
  });
  await sleep(2500);
  runner.kill("SIGKILL"); await sleep(150);
  return { work, argvLog: (() => { try { return readFileSync(join(work, "argv.log"), "utf8"); } catch { return ""; } })(),
    envLog: (() => { try { return readFileSync(join(work, "env.log"), "utf8"); } catch { return ""; } })(),
    registers: [...registers], sends: [...sends] };
}

// ---- success path: command shape, prompt delivery, env ----------------------------------
{
  const r = await drill(`#!/bin/sh
printf '%s\\n' "$@" > "$(dirname $0)/../argv.log"
env | grep '^RELAY_' > "$(dirname $0)/../env.log"
echo "dsh-drill answer"
exit 0
`);
  const argv = r.argvLog.trim().split("\n");
  ok("invokes `dsh --profile trantor <task>`", argv[0] === "--profile" && argv[1] === "trantor" && argv.length === 3, JSON.stringify(argv));
  ok("the task positional carries the kickoff prompt", /kickoff: introduce yourself/.test(argv[2] || ""), (argv[2] || "").slice(0, 60));
  ok("seat env carries the RELAY_* identity for the profile's hooks + relay MCP",
    /RELAY_AGENT=dsh/.test(r.envLog) && /RELAY_PROJECT=tt-dsh/.test(r.envLog) && r.envLog.includes(`RELAY_URL=${HUB}`), r.envLog.trim());
  ok("a clean turn leaves the seat registered healthy (no failure broadcast)",
    r.registers.length > 0 && !r.sends.some(s => /FAILED|DOWN/.test(s.text || "")));
}

// ---- failure path: an exhausted DeepSeek account is classified, not mystery-crashed ------
{
  const r = await drill(`#!/bin/sh
echo "Error: 402 Payment Required - insufficient balance on this API key" >&2
exit 1
`);
  const failMsg = r.sends.find(s => /FAILED|DOWN/.test(s.text || ""));
  ok("a failed dsh turn is reported to the bus", !!failMsg, JSON.stringify(r.sends.map(s => s.text)));
  ok("...classified exhausted (suggests trantor swap)", /exhausted/.test(failMsg?.text || ""), failMsg?.text);
}

hub.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

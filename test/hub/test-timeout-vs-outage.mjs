#!/usr/bin/env node
// A TIMEOUT must not read as a DEAD HUB.
//
// 2026-09-09: /tasks for trantor is 1.59MB across 941 cards and takes 625-961ms against a 1500ms
// budget. So it passes on a good run and aborts on a slow one — and the abort surfaced as
// "hub 0 on /tasks", which is what a genuinely down hub also prints. I retried past it four times
// as a blip; the duty seat hit it and could not file its own root-cause card because of it.
//
// The two need OPPOSITE responses. A timeout means the hub is fine and the read is too big: retry,
// and go make the read smaller. An outage means investigate the hub. Rendering both as "hub 0"
// makes the right response unknowable, which is this whole day's theme — a status surface
// reporting the wrong thing about the state underneath.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer } from "node:http";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); } };

const { signedGet } = await import(`${ROOT}/hooks/lib/api.mjs`);

// A hub that is UP and answers 200 — just slower than the caller's budget. This is the real
// /tasks case, not a simulation of a broken server.
const slow = createServer((req, res) => {
  setTimeout(() => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ tasks: [] }));
  }, 400);
});
await new Promise(r => slow.listen(0, "127.0.0.1", r));
const slowPort = slow.address().port;

console.log("\n# a healthy-but-slow hub reads as a TIMEOUT, never as an outage");
{
  const r = await signedGet(`http://127.0.0.1:${slowPort}/tasks`, { timeoutMs: 80 });
  ok("the read fails", r.ok === false);
  ok("status stays 0, so every existing caller is unaffected", r.status === 0, String(r.status));
  ok("it is flagged as a TIMEOUT", r.timedOut === true, JSON.stringify(r));
  ok("the reason names the budget it blew", /timed out after 80ms/.test(r.reason || ""), r.reason);
  ok("it does NOT claim the hub is unreachable", !/unreachable/.test(r.reason || ""), r.reason);
}

console.log("\n# the same read inside its budget still succeeds");
{
  const r = await signedGet(`http://127.0.0.1:${slowPort}/tasks`, { timeoutMs: 5000 });
  ok("a generous budget gets the 200", r.ok === true && r.status === 200, `ok=${r.ok} status=${r.status}`);
  ok("and carries no timeout flag", !r.timedOut);
}
slow.close();

console.log("\n# a genuinely DOWN hub is still reported as unreachable, not as a timeout");
{
  // Port 1 is reserved and refuses immediately — a connection refusal, not a slow answer.
  const r = await signedGet("http://127.0.0.1:1/tasks", { timeoutMs: 3000 });
  ok("the read fails", r.ok === false);
  ok("it is NOT flagged as a timeout", r.timedOut !== true, JSON.stringify(r));
  ok("the reason is not a timeout message", !/timed out/.test(r.reason || ""), r.reason);
  ok("the two cases are distinguishable at all — the whole point",
    r.timedOut !== true, `outage reason: ${r.reason}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

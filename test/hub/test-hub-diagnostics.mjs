#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHubDiagnostics } from "../../lib/hub-diagnostics.mjs";

const lines = [];
let lagClock = 0;
const histogram = {
  max: 0,
  enable() {},
  disable() {},
  reset() { this.max = 0; },
};
const diagnostics = createHubDiagnostics({
  histogram,
  now: () => lagClock,
  logIntervalMs: 0,
  log: line => lines.push(line),
});
diagnostics.start();
try {
  lagClock = 300;
  histogram.max = 300e6;
  diagnostics.checkLag();
  assert.equal(lines.length, 0, `sub-threshold block logged: ${lines.join("\n")}`);

  const req = { method: "POST", url: "/task/update?secret=not-logged" };
  diagnostics.beginRequest(req);
  diagnostics.recordStep("snapshot.serialize", 1234);
  lagClock = 1000;
  histogram.max = 700e6;
  diagnostics.endRequest(req);
  diagnostics.checkLag();
  diagnostics.checkLag();
  assert.equal(lines.length, 1, `700ms block should log exactly once: ${lines.join("\n")}`);
  assert.match(lines[0], /event-loop stall 700ms \(>500ms\)/);
  assert.match(lines[0], /inFlight=POST \/task\/update \(700ms\)/);
  assert.doesNotMatch(lines[0], /secret=not-logged/);
  assert.match(lines[0], /lastStep=snapshot\.serialize bytes=1234 age=700ms/);
} finally {
  diagnostics.stop();
}

const slowLines = [];
let clock = 0;
const requests = createHubDiagnostics({
  now: () => clock,
  logIntervalMs: 5000,
  log: line => slowLines.push(line),
});
const quick = { method: "GET", url: "/health", headers: {} };
requests.beginRequest(quick);
clock = 1000;
requests.endRequest(quick, { statusCode: 200 });
assert.equal(slowLines.length, 0, "a request at the threshold must stay quiet");

const slow = { method: "POST", url: "/task/update?private=query", headers: {}, _bodyBytes: 73 };
clock = 2000;
requests.beginRequest(slow);
clock = 3001;
requests.endRequest(slow, { statusCode: 201 });
assert.equal(slowLines.length, 1);
assert.match(slowLines[0], /slow request POST \/task\/update 1001ms \(>1000ms\) body=73B status=201/);
assert.doesNotMatch(slowLines[0], /private=query/);

clock = 4000;
requests.beginRequest(slow);
clock = 5002;
requests.endRequest(slow, { statusCode: 201 });
assert.equal(slowLines.length, 1, "slow-request logs must be rate-limited");

// Long-poll and SSE run for minutes by design: no slow line, and they don't eat the rate limit.
const longLines = [];
let lclock = 0;
const longPoll = createHubDiagnostics({ now: () => lclock, logIntervalMs: 5000, log: line => longLines.push(line) });
const poll = { method: "GET", url: "/poll?since=5", headers: {} };
longPoll.beginRequest(poll);
lclock = 280_000;
longPoll.endRequest(poll, { statusCode: 200 });
assert.equal(longLines.length, 0, "a long-poll must never log as a slow request");
const realSlow = { method: "GET", url: "/tasks", headers: {} };
longPoll.beginRequest(realSlow);
lclock = 281_400;
longPoll.endRequest(realSlow, { statusCode: 200 });
assert.equal(longLines.length, 1, "a real slow request right after a long-poll still logs");
assert.match(longLines[0], /slow request GET \/tasks 1400ms/);

console.log("hub diagnostics: sub-500ms quiet; 700ms stall logged once with route and serialize size; slow routes thresholded and rate-limited");

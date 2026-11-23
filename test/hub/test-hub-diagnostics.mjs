#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHubDiagnostics } from "../../lib/hub-diagnostics.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const block = ms => {
  const until = performance.now() + ms;
  while (performance.now() < until) {}
};

const lines = [];
const diagnostics = createHubDiagnostics({
  sampleIntervalMs: 40,
  logIntervalMs: 0,
  log: line => lines.push(line),
});
diagnostics.start();
try {
  await sleep(100);
  block(300);
  await sleep(120);
  assert.equal(lines.length, 0, `sub-threshold block logged: ${lines.join("\n")}`);

  const req = { method: "POST", url: "/task/update?secret=not-logged" };
  diagnostics.beginRequest(req);
  diagnostics.recordStep("snapshot.serialize", 1234);
  block(700);
  diagnostics.endRequest(req);
  const deadline = Date.now() + 1000;
  while (!lines.length && Date.now() < deadline) await sleep(20);
  await sleep(120);
  assert.equal(lines.length, 1, `700ms block should log exactly once: ${lines.join("\n")}`);
  assert.match(lines[0], /event-loop stall \d+ms \(>500ms\)/);
  assert.match(lines[0], /inFlight=POST \/task\/update/);
  assert.doesNotMatch(lines[0], /secret=not-logged/);
  assert.match(lines[0], /lastStep=snapshot\.serialize bytes=1234/);
} finally {
  diagnostics.stop();
}

console.log("hub diagnostics: sub-500ms quiet; 700ms stall logged once with route and serialize size");

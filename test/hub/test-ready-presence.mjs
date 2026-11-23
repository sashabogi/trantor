#!/usr/bin/env node
import assert from "node:assert/strict";
import { startTestHub } from "../lib/test-hub.mjs";

const hub = await startTestHub();
const project = "ready-presence";
const session = `codex:${project}`;
const post = async (path, body) => {
  const response = await fetch(hub.base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
};
const peer = async () => {
  const { peers } = await (await fetch(`${hub.base}/peers?project=${project}`)).json();
  return peers.find(candidate => candidate.session === session);
};
const ready = () => post("/send", {
  from: session,
  to: "all",
  project,
  kind: "status",
  text: "codex reporting — ready for a contract",
});

try {
  await post("/register", { session, project, status: "crew member booting", kind: "agent" });
  await ready();
  const idle = await peer();
  assert.equal(idle.status, "idle");
  assert.equal(idle.phase, "idle");
  assert.ok(idle.phaseSince > 0);

  await post("/register", { session, project, status: "working · contract", phase: "working" });
  await ready();
  const working = await peer();
  assert.equal(working.status, "working · contract");
  assert.equal(working.phase, "working");
  console.log("PASS ready broadcast clears only stale boot presence");
} finally {
  await hub.stop();
}

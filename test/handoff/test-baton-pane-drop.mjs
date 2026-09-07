#!/usr/bin/env node
import assert from "node:assert/strict";
import { agentDropStep } from "../../bin/baton-pane.mjs";

assert.equal(agentDropStep(true, 9_999, 10_000), "wait");
assert.equal(agentDropStep(false, 10, 10_000), "dropped");
assert.equal(agentDropStep(true, 10_000, 10_000), "deadline");

console.log("baton pane agent-drop gate: 3 passed, 0 failed");

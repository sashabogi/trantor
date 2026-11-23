#!/usr/bin/env node
import assert from "node:assert/strict";
import { agentDropStep, kickoffVerdict } from "../../bin/baton-pane.mjs";

assert.equal(agentDropStep(true, 9_999, 10_000), "wait");
assert.equal(agentDropStep(false, 10, 10_000), "dropped");
assert.equal(agentDropStep(true, 10_000, 10_000), "deadline");

// #13913: herdr's answer is the receipt. A prompted successor is agent_prompted; a wait that
// timed out is the busy successor ("sent, not yet picked up"), never a failure; any other
// herdr error names its code and message verbatim.
assert.equal(kickoffVerdict(`{"id":"trantor:agent.prompt","result":{"type":"agent_prompted","agent":{"agent":"claude","agent_status":"working"}}}`), "agent_prompted");
assert.equal(kickoffVerdict(`{"error":{"code":"timeout","message":"prompt wait timed out"},"id":"trantor:agent.prompt"}`), "sent, not yet picked up");
assert.equal(kickoffVerdict(`{"error":{"code":"agent_not_ready","message":"agent drill is blocked during startup and is not ready for prompts"},"id":"cli:agent:start"}`), "agent_not_ready (agent drill is blocked during startup and is not ready for prompts)");
assert.equal(kickoffVerdict("not json"), "unreadable_response");
assert.equal(kickoffVerdict(`{"id":"x","result":{"type":"pong"}}`), "unexpected_response");

console.log("baton pane agent-drop gate: 3 passed, 0 failed");
console.log("baton pane kickoff verdict: 5 passed, 0 failed");

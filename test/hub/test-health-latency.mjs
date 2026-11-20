#!/usr/bin/env node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestHub } from "../lib/test-hub.mjs";

const dir = mkdtempSync(join(tmpdir(), "trantor-health-latency-"));
mkdirSync(join(dir, ".agent-bus"), { recursive: true });
const now = Date.now();
const messages = Array.from({ length: 5000 }, (_, i) => ({
  id: i + 1, ts: now - (5000 - i) * 1000, from: `seat-${i % 24}:trantor`,
  to: i % 5 === 0 ? "trantor-duty" : "all", text: `message ${i}`, project: "trantor",
}));
const events = Array.from({ length: 50000 }, (_, i) => ({
  id: i + 1, ts: now - (50000 - i) * 100, type: "message", project: "trantor",
  by: `seat-${i % 24}:trantor`, data: { msgId: i + 1, refs: [] },
}));
writeFileSync(join(dir, ".agent-bus", "bus.json"), JSON.stringify({
  messages, seq: messages.length, events, eventSeq: events.length,
  peers: { "trantor-duty": { lastSeen: now, deliveredUpTo: 0, project: "trantor" } },
  dutySession: "trantor-duty",
}));

let hub;
try {
  hub = await startTestHub({ dir, env: { RELAY_EVENT_CAP: "50000", RELAY_DUTY_SESSION: "trantor-duty" } });
  const samples = [];
  for (let i = 0; i < 50; i++) {
    const started = performance.now();
    const response = await fetch(`${hub.base}/health`);
    if (!response.ok) throw new Error(`/health returned ${response.status}`);
    await response.arrayBuffer();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  console.log(`/health p95 ${p95.toFixed(2)}ms; max ${samples.at(-1).toFixed(2)}ms`);
  if (p95 >= 100) throw new Error(`/health p95 ${p95.toFixed(2)}ms is not under 100ms`);
} finally {
  if (hub) await hub.stop();
  rmSync(dir, { recursive: true, force: true });
}

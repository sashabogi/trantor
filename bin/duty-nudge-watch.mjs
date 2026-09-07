#!/usr/bin/env node
import { existsSync, unlinkSync } from "node:fs";
import { observedDutyNudgeIds, recordDutyNudges } from "../lib/duty-nudges.mjs";

const [transcriptDir, statePath, sinceText, planText, stopPath] = process.argv.slice(2);
const plan = JSON.parse(planText || "{}");
const sinceMs = Number(sinceText);
const deadline = Date.now() + 30 * 60 * 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let complete = false;
const recordedIds = new Set();

while (Date.now() < deadline) {
  if (!complete) {
    const observedIds = observedDutyNudgeIds(transcriptDir, sinceMs);
    const newIds = new Set([...observedIds].filter(id => !recordedIds.has(id)));
    await recordDutyNudges({ plan, observedIds: newIds, statePath });
    for (const id of newIds) recordedIds.add(id);
    complete = plan.items.every(item => recordedIds.has(item.id));
  }
  if (existsSync(stopPath)) break;
  await sleep(100);
}

try { unlinkSync(stopPath); } catch {}

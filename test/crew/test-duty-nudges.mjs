#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditDutyNudges, claudeTranscriptDir, dutyNudgeDirective, observedDutyNudgeIds, planDutyNudges,
} from "../../lib/duty-nudges.mjs";

const work = mkdtempSync(join(tmpdir(), "trantor-duty-nudges-"));
const statePath = join(work, "duty-nudged.json");
const transcriptDir = join(work, "transcripts");
const watcherPath = fileURLToPath(new URL("../../bin/duty-nudge-watch.mjs", import.meta.url));
let pass = 0;
let fail = 0;
const ok = (name, condition, detail = "") => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const feed = ids => ids.map(id => ({
  from: "hub:duty",
  text: `⚠️ UNDELIVERED for 2m: #${id} codex:proj -> MacBook-Pro-M1:proj — "probe"`,
}));

console.log("# duty runner per-id nudge enforcement");
try {
  ok("duty cwd maps to Claude's real transcript slug",
    claudeTranscriptDir("/Users/example/.agent-bus/trantor-duty", "/Users/example")
      === "/Users/example/.claude/projects/-Users-example--agent-bus-trantor-duty");
  const first = planDutyNudges(feed(["A"]), statePath);
  ok("first feed plans A", first.targets.length === 1 && first.targets[0].ids.join() === "A");
  const firstPrompt = dutyNudgeDirective(first);
  ok("prompt names the exact required id", firstPrompt.includes("MacBook-Pro-M1:proj: #A"));
  ok("prompt limits metronome suppression to the same id", firstPrompt.includes("metronome rule applies only to the SAME id"));

  mkdirSync(transcriptDir);
  const stamp = Date.now() - 100;
  const stopPath = join(work, "watch.stop");
  const watcher = spawn(process.execPath, [
    watcherPath, transcriptDir, statePath, String(stamp), JSON.stringify(first), stopPath,
  ], { stdio: "inherit" });
  await new Promise(resolve => setTimeout(resolve, 100));
  writeFileSync(join(transcriptDir, "turn.jsonl"), `${JSON.stringify({
    timestamp: new Date().toISOString(),
    message: { content: [
      {
        type: "tool_use",
        name: "SendMessage",
        input: { message: "Trantor delivery nudge from the duty seat: unread id #A" },
      },
      {
        type: "tool_use",
        name: "SendMessage",
        input: { message: "Duty nudge: #B plus full message content" },
      },
    ] },
  })}\n`);
  for (let attempt = 0; attempt < 30; attempt++) {
    try { if (JSON.parse(readFileSync(statePath, "utf8")).nudged.A) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  ok("watcher persists A before the duty turn ends",
    JSON.parse(readFileSync(statePath, "utf8")).nudged.A?.recipient === "MacBook-Pro-M1:proj");
  ok("a concurrent second wake with A plans nothing", planDutyNudges(feed(["A"]), statePath).items.length === 0);
  writeFileSync(stopPath, "");
  await new Promise(resolve => watcher.on("close", resolve));
  const observedA = observedDutyNudgeIds(transcriptDir, stamp);
  ok("actual SendMessage transcript verifies A", observedA.has("A"));
  ok("non-template content-bearing SendMessage is not verification", !observedA.has("B"));
  const firstFailures = [];
  const firstAudit = await auditDutyNudges({
    plan: first, observedIds: observedA, statePath,
    reportFailure: async target => firstFailures.push(target),
  });
  ok("verified A produces no failure", firstAudit.missing.length === 0 && firstFailures.length === 0);
  const persisted = JSON.parse(readFileSync(statePath, "utf8"));
  ok("verified A is persisted", persisted.nudged.A?.recipient === "MacBook-Pro-M1:proj");

  const second = planDutyNudges(feed(["A", "B"]), statePath);
  ok("second feed suppresses only already-nudged A", second.items.length === 1 && second.items[0].id === "B");
  ok("second prompt requires B exactly", dutyNudgeDirective(second).includes("MacBook-Pro-M1:proj: #B"));
  const skippedFailures = [];
  const skipped = await auditDutyNudges({
    plan: second, observedIds: new Set(), statePath,
    reportFailure: async target => skippedFailures.push(target),
  });
  ok("skipping B returns B as missing", skipped.missing.length === 1 && skipped.missing[0].ids.join() === "B");
  ok("skipping B records one target failure", skippedFailures.length === 1 && skippedFailures[0].ids.join() === "B");
  const afterSkip = JSON.parse(readFileSync(statePath, "utf8"));
  ok("skipped B is not marked nudged", !afterSkip.nudged.B);
  const retry = planDutyNudges(feed(["A", "B"]), statePath);
  ok("an un-nudged B remains mandatory next turn", retry.items.length === 1 && retry.items[0].id === "B");
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

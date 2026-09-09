#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditDutyNudges, claimDutyNudges, claudeTranscriptDir, dutyNudgeDirective,
  observedDutyNudgeIds, planDutyNudges,
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
  const first = await claimDutyNudges({ messages: feed(["A"]), statePath, owner: "turn-1" });
  ok("first feed plans A", first.targets.length === 1 && first.targets[0].ids.join() === "A");
  ok("A is reserved at plan time", JSON.parse(readFileSync(statePath, "utf8")).planned.A?.owner === "turn-1");
  const overlapping = await claimDutyNudges({ messages: feed(["A"]), statePath, owner: "turn-2" });
  ok("an overlapping turn cannot re-plan reserved A", overlapping.items.length === 0);
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
        input: { message: "Trantor delivery nudge from the duty seat: unread id #A. This nudge carries no message content; the signed bus messages are the source of truth." },
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
  ok("watcher finalizes A by removing its planned mark", !JSON.parse(readFileSync(statePath, "utf8")).planned.A);
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

  const second = await claimDutyNudges({ messages: feed(["A", "B"]), statePath, owner: "turn-3" });
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
  ok("skipped B releases its planned mark", !afterSkip.planned.B);
  const retry = await claimDutyNudges({ messages: feed(["A", "B"]), statePath, owner: "turn-4" });
  ok("an un-nudged B remains mandatory next turn", retry.items.length === 1 && retry.items[0].id === "B");
} finally {
  rmSync(work, { recursive: true, force: true });
}

// --- #6951 fault 2: a delivered message must not be nudged for -------------------------------
// The ledger answers "did I nudge for this id"; it cannot answer "does this id still need one".
// Those came apart on 2026-09-09: duty nudged the orchestrator four times for ids its own cursor
// was already past — real escalations when duty first saw them, read by the recipient before duty
// got a turn, and nothing re-checked. Every nudge wakes a session and costs a turn on both sides.
{
  const p = join(mkdtempSync(join(tmpdir(), "duty-delivered-")), "duty-nudged.json");
  const msgs = feed(["A", "B"]);
  // The recipient has read everything: deliveredUpTo is past both ids.
  const allRead = await claimDutyNudges({
    messages: msgs, statePath: p, owner: "turn-1",
    isDelivered: async () => true,
  });
  ok("a fully-read inbox plans NO nudges", allRead.items.length === 0,
    JSON.stringify(allRead.items.map(i => i.id)));
  // Nothing was claimed, so a later wake on the same ids is still free to nudge if they go unread.
  const nowUnread = await claimDutyNudges({
    messages: msgs, statePath: p, owner: "turn-2",
    isDelivered: async () => false,
  });
  ok("skipping a delivered id does not burn it — an unread id still earns its nudge",
    nowUnread.items.length === 2, JSON.stringify(nowUnread.items.map(i => i.id)));
}
{
  const p = join(mkdtempSync(join(tmpdir(), "duty-partial-")), "duty-nudged.json");
  // Only the first id has been read. The second must still be nudged.
  const plan = await claimDutyNudges({
    messages: feed(["A", "B"]), statePath: p, owner: "turn-1",
    isDelivered: async ({ id }) => id === "A",
  });
  ok("a partially-read batch nudges only what is still unread",
    plan.items.length === 1 && plan.items[0].id === "B", JSON.stringify(plan.items.map(i => i.id)));
}
{
  const p = join(mkdtempSync(join(tmpdir(), "duty-unknown-")), "duty-nudged.json");
  // The hub is unreachable. UNKNOWN IS NOT DELIVERED: a missed nudge is worse than a redundant one.
  const plan = await claimDutyNudges({
    messages: feed(["A"]), statePath: p, owner: "turn-1",
    isDelivered: async () => { throw new Error("hub unreachable"); },
  });
  ok("a failing delivery check leaves the nudge STANDING, never silently drops it",
    plan.items.length === 1, JSON.stringify(plan.items.map(i => i.id)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

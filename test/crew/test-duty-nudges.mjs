#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditDutyNudges, claimDutyNudges, claudeTranscriptDir, dutyNudgeDirective,
  observedDutyNudgeIds, planDutyNudges, recordDutyNudges, WAKE_TAKEOVER_MS,
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
  ok("a concurrent second wake with A plans nothing", (await planDutyNudges(feed(["A"]), statePath)).items.length === 0);
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
// The ledger answers "did I nudge for this id"; it cannot answer "does this id still need one" —
// duty nudged an orchestrator four times for ids its own cursor was already past (#6951). Every
// nudge wakes a session and costs a turn on both sides.
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

// --- #7430: the audit must never demand a nudge the seat cannot make --------------------------
// Mail addressed to a recipient with no local session (duty's own echoes) and mail for a session
// observed busy both used to count as "skipped mandatory nudges", so every alert rode a redelivery
// backoff and the pending queue only ever grew.
{
  const p = join(mkdtempSync(join(tmpdir(), "duty-terminal-")), "duty-nudged.json");
  const msgs = [...feed(["T"]), {
    from: "hub:duty", text: `⚠️ UNDELIVERED for 2m: #U claude:src -> duty — "self echo"`,
  }];
  const plan = await claimDutyNudges({
    messages: msgs, statePath: p, owner: "turn-1",
    resolveRecipient: async r => (r === "duty" ? "unknown" : "idle"),
  });
  ok("an unresolvable recipient is terminal, not a planned nudge",
    plan.items.length === 1 && plan.terminal.length === 1 && plan.terminal[0].ids.join() === "U",
    JSON.stringify({ items: plan.items.map(i => i.id), terminal: plan.terminal }));
  const saved = JSON.parse(readFileSync(p, "utf8"));
  ok("the terminal id is recorded with a reason, never to be retried",
    saved.nudged.U?.terminal === true && Boolean(saved.nudged.U?.reason),
    JSON.stringify(saved.nudged.U || null));
  const again = await planDutyNudges(msgs, p, { resolveRecipient: async () => "idle" });
  ok("a terminal id is never re-planned on a later turn", again.items.length === 0,
    JSON.stringify(again.items.map(i => i.id)));
  const audit = await auditDutyNudges({
    plan, observedIds: new Set(plan.items.map(i => i.id)), statePath: p,
    reportFailure: async () => { throw new Error("terminal id reported as a skipped nudge"); },
  });
  ok("the audit demands nothing for a terminal recipient", audit.missing.length === 0);
}
{
  const p = join(mkdtempSync(join(tmpdir(), "duty-busy-")), "duty-nudged.json");
  const two = [{ from: "hub:duty", text: `⚠️ UNDELIVERED for 2m: #B claude:src -> codex:proj — "stuck"` }, ...feed(["C"])];
  const plan = await claimDutyNudges({
    messages: two, statePath: p, owner: "turn-1",
    resolveRecipient: async r => (r === "codex:proj" ? "busy" : "idle"),
  });
  ok("a busy recipient is planned as a no-op, not a mandatory nudge",
    plan.items.map(i => i.id).join() === "C" && plan.noops.length === 1 && plan.noops[0].ids.join() === "B",
    JSON.stringify({ items: plan.items.map(i => i.id), noops: plan.noops }));
  ok("a busy id is NOT terminalised — the next turn re-resolves it",
    !JSON.parse(readFileSync(p, "utf8")).nudged.B);
  ok("the directive marks the busy id do-not-nudge",
    dutyNudgeDirective(plan).includes("NO-OP") && dutyNudgeDirective(plan).includes("#B"),
    dutyNudgeDirective(plan).slice(0, 120));
  const audit = await auditDutyNudges({
    plan, observedIds: new Set(["C"]), statePath: p,
    reportFailure: async () => { throw new Error("busy id reported as a skipped nudge"); },
  });
  ok("the audit does not count a busy recipient missing", audit.missing.length === 0);
  ok("a resolver crash fails OPEN to a standing nudge",
    (await planDutyNudges(feed(["Z"]), p, { resolveRecipient: async () => { throw new Error("x"); } })).items.length === 1);
}

// --- #7429: the mechanical wake gets first chance at a fresh duty claim -----------------------
// The duty LLM turn claims an alert for minutes, which used to lock the 5s wake daemon out for a
// whole turn. The ledger is the referee: wake may take over a FRESH duty claim, nothing may take
// over a wake claim, and the audit counts a ledger-verified id handled instead of missing.
{
  const p = join(mkdtempSync(join(tmpdir(), "duty-takeover-")), "duty-nudged.json");
  const t0 = 1_700_000_000_000;
  const duty = await claimDutyNudges({ messages: feed(["A"]), statePath: p, owner: "duty-turn-1", now: t0 });
  ok("duty claims the alert", duty.items.length === 1 && duty.targets.length === 1);
  const wake = await claimDutyNudges({ messages: feed(["A"]), statePath: p, owner: "wake:999", now: t0 + 5000 });
  ok("wake takes over a fresh duty claim inside the grace", wake.items.length === 1);
  ok("the takeover moves the claim to the wake owner",
    JSON.parse(readFileSync(p, "utf8")).planned.A?.owner === "wake:999");
  const dutyAgain = await claimDutyNudges({ messages: feed(["A"]), statePath: p, owner: "duty-turn-2", now: t0 + 6000 });
  ok("duty never steals a wake claim", dutyAgain.items.length === 0);
  // wake's socket is held: its audit releases its own claim, with no terminal marking anywhere.
  const wakeAudit = await auditDutyNudges({
    plan: wake, observedIds: new Set(), statePath: p, reportFailure: async () => {},
  });
  const afterRelease = JSON.parse(readFileSync(p, "utf8"));
  ok("a held socket releases the wake claim without terminal marking",
    !afterRelease.planned.A && !afterRelease.nudged.A, JSON.stringify(afterRelease));
  ok("the wake audit still reports the id as undelivered for its own logging", wakeAudit.missing.length === 1);
  const duty2 = await claimDutyNudges({ messages: feed(["A"]), statePath: p, owner: "duty-turn-3", now: t0 + 7000 });
  ok("duty re-claims after the release", duty2.items.length === 1);
  const late = await claimDutyNudges({
    messages: feed(["A"]), statePath: p, owner: "wake:998", now: t0 + 7000 + WAKE_TAKEOVER_MS + 1000,
  });
  ok("past the grace a duty claim is respected", late.items.length === 0);
  // ...and when wake verifies first, duty's audit reads the ledger instead of crying missing.
  await recordDutyNudges({ plan: { ...duty2, owner: "wake:998" }, observedIds: new Set(["A"]), statePath: p, now: t0 + 8000 });
  const recorded = JSON.parse(readFileSync(p, "utf8")).nudged.A;
  ok("a wake-verified entry records the mechanical source", recorded?.source === "wake", JSON.stringify(recorded || null));
  const dutyAudit = await auditDutyNudges({
    plan: duty2, observedIds: new Set(), statePath: p,
    reportFailure: async () => { throw new Error("a ledger-verified id was reported missing"); },
  });
  ok("the audit counts a ledger-verified id handled even when this turn did not nudge it",
    dutyAudit.missing.length === 0);
  await recordDutyNudges({ plan: duty2, observedIds: new Set(["A"]), statePath: p, now: t0 + 99999 });
  const kept = JSON.parse(readFileSync(p, "utf8")).nudged.A;
  ok("a later record from the other path never clobbers the first",
    kept.source === "wake" && kept.nudgedAt === recorded.nudgedAt, JSON.stringify(kept || null));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

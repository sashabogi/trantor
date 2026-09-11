#!/usr/bin/env node
// #7430 runner drill: the poison batch — an alert for recipient `duty` (the duty seat's own echo)
// and one for a BUSY local session — must plan ZERO mandatory nudges, so the turn ends with
// deliveryFails 0; a failed audit re-queues only the missing ids; stale hub alerts shed at queue
// time. Never runs the full suite: this file is the card's own gate.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditDutyNudges, claimDutyNudges, dutyNudgeDirective,
  requeueMissingWakeMessages, shedExpiredHubAlerts,
} from "../../lib/duty-nudges.mjs";
import { dutyRecipientResolver } from "../../lib/duty-recipient.mjs";

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = "") => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

const HOST = "MacBook-Pro-M1";
const work = mkdtempSync(join(tmpdir(), "trantor-duty-audit-"));
const alert = (id, recipient) => ({
  from: "hub:duty", ts: Date.now(),
  text: `⚠️ UNDELIVERED for 2m: #${id} claude:src -> ${recipient} — "probe"`,
});

// herdr stands in for the real agent list: proj-pane is WORKING, idle-proj-pane is idle.
const listAgents = async () => ({ result: { agents: [
  { agent: "claude", agent_status: "working", agent_session: { value: "sess-proj" }, cwd: "/Users/x/proj" },
  { agent: "claude", agent_status: "idle", agent_session: { value: "sess-idle" }, cwd: "/Users/x/idle-proj" },
] } });
writeFileSync(join(work, "orch-sessions.txt"), "proj\tsess-proj\nidle-proj\tsess-idle\n");
const resolveRecipient = dutyRecipientResolver({ localHost: HOST, bus: work, listAgents });

try {
  const statePath = join(work, "duty-nudged.json");

  // 1. The poison batch: everything in it is either the seat's own echo, busy, or remote.
  const poison = [alert("D1", "duty"), alert("D2", `${HOST}:proj`), alert("D3", "dev-host:proj")];
  const plan = await claimDutyNudges({ messages: poison, statePath, owner: "duty-turn-1", resolveRecipient });
  ok("the poison batch plans ZERO mandatory nudges", plan.items.length === 0, JSON.stringify(plan.items));
  ok("the seat's own echo is terminal", plan.terminal.some(t => t.ids.includes("D1")));
  ok("the busy session is a no-op", plan.noops.some(t => t.ids.includes("D2")));
  ok("a remote recipient is never claimed", plan.terminal.some(t => t.ids.includes("D3")));
  ok("the directive orders no nudge at all",
    !dutyNudgeDirective(plan).includes("MECHANICAL DUTY NUDGE REQUIREMENT"));
  const poisonFailures = [];
  const poisonAudit = await auditDutyNudges({
    plan, observedIds: new Set(), statePath, reportFailure: async t => poisonFailures.push(t),
  });
  ok("the turn ends with nothing missing — deliveryFails stays 0",
    poisonAudit.missing.length === 0 && poisonFailures.length === 0,
    JSON.stringify({ missing: poisonAudit.missing, failures: poisonFailures.length }));

  // 2. A batch with one genuinely skipped id: only that message may ride the redelivery.
  const mixed = [alert("F1", "duty"), alert("F2", `${HOST}:proj`), alert("F3", `${HOST}:idle-proj`)];
  const mixedPlan = await claimDutyNudges({ messages: mixed, statePath, owner: "duty-turn-2", resolveRecipient });
  ok("only the idle local recipient is claimed for a nudge",
    mixedPlan.items.length === 1 && mixedPlan.items[0].id === "F3", JSON.stringify(mixedPlan.items));
  const mixedFailures = [];
  const mixedAudit = await auditDutyNudges({
    plan: mixedPlan, observedIds: new Set(), statePath, reportFailure: async t => mixedFailures.push(t),
  });
  ok("only the skipped idle-recipient id is missing",
    mixedAudit.missing.length === 1 && mixedAudit.missing[0].ids.join() === "F3",
    JSON.stringify(mixedAudit.missing));
  const kept = requeueMissingWakeMessages(mixed, mixedAudit.missing);
  ok("the re-queue keeps only the missing id's message",
    kept.length === 1 && kept[0].text.includes("#F3"), JSON.stringify(kept.map(m => m.text)));
  ok("terminal and busy alerts are consumed, not redelivered",
    !kept.some(m => m.text.includes("#F1") || m.text.includes("#F2")));

  // 3. TTL shed at queue time: expired hub alerts go, peer mail never expires.
  const now = Date.now();
  const batch = [
    alert("G1", "duty"),
    { ...alert("G2", "duty"), ts: now - 31 * 60_000 },
    { from: "codex:proj", ts: now - 31 * 60_000, text: "peer mail is never a stale moment" },
  ];
  const shed = shedExpiredHubAlerts(batch, 30 * 60_000, now);
  ok("only expired hub:duty alerts are shed at queue time",
    shed.shed === 1 && shed.kept.length === 2
    && shed.kept.some(m => m.text.includes("#G1")) && shed.kept.some(m => m.from === "codex:proj"),
    JSON.stringify({ shed: shed.shed, kept: shed.kept.length }));

  // 4. A resolver outage (herdr down) fails OPEN: the nudge stands rather than being dropped.
  const failing = dutyRecipientResolver({
    localHost: HOST, bus: work, listAgents: async () => { throw new Error("herdr down"); },
  });
  const open = await claimDutyNudges({
    messages: [alert("H1", `${HOST}:proj`)], statePath, owner: "duty-turn-3", resolveRecipient: failing,
  });
  ok("a resolver outage fails OPEN to a standing nudge", open.items.length === 1, JSON.stringify(open.items));
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// A hub staleness alert expires. A peer's message never does.
//
// The 2026-09-09 wedge, and the reason restarting the duty seat did not clear it. The hub sends the
// duty seat alerts of the form "⚠️ UNDELIVERED for 2m: #16909 …" — go nudge someone. That is true
// for about two minutes. The pending queue had no expiry, so:
//
//   hub notices undelivered mail → alerts duty → duty is parked and cannot work it off →
//   hub notices again → more alerts → queue grows → restart faithfully redelivers the backlog →
//   seat re-wedges on work that expired hours ago
//
// Measured on the real queue at the time of the fix: 49 held, 44 of them expired hub alerts, the
// oldest 22.1 hours old, every one describing a two-minute condition.
//
// The rule is deliberately narrow and this file exists mostly to keep it that way: ONLY messages
// the hub generated, ONLY past the TTL. A peer's message is never dropped for being old — a seat
// that silently discards a teammate's request is the exact failure the bus exists to prevent, and
// no backlog is worth causing it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};

const src = readFileSync(`${ROOT}/bin/crew-runner.mjs`, "utf8");

// The predicate under test, mirrored exactly. Kept in step with the runner by the source assertions
// below — the runner cannot export it without booting a seat.
const TTL = 30 * 60_000;
const isExpiredHubAlert = (m) =>
  m?.from === "hub:duty" && Number.isFinite(m?.ts) && Date.now() - m.ts > TTL;

const MIN = 60_000, HOUR = 3.6e6;
const msg = (from, agoMs, extra = {}) => ({ from, ts: Date.now() - agoMs, text: "x", ...extra });

console.log("\nexpired hub alerts are shed");
{
  ok("a 22h-old hub alert expires", isExpiredHubAlert(msg("hub:duty", 22 * HOUR)));
  ok("a 31m-old hub alert expires", isExpiredHubAlert(msg("hub:duty", 31 * MIN)));
  ok("a 29m-old hub alert survives — inside the TTL", !isExpiredHubAlert(msg("hub:duty", 29 * MIN)));
  ok("a brand-new hub alert survives", !isExpiredHubAlert(msg("hub:duty", 5 * 1000)));
}

console.log("\nA PEER'S MESSAGE IS NEVER DROPPED, at any age");
{
  ok("a 22h-old peer message survives", !isExpiredHubAlert(msg("codex:stone-tracker", 22 * HOUR)));
  ok("a 30-DAY-old peer message survives", !isExpiredHubAlert(msg("glm:trantor", 30 * 24 * HOUR)));
  ok("an orchestrator message survives", !isExpiredHubAlert(msg("MacBook-Pro-M1:trantor", 48 * HOUR)));
  ok("a message with no timestamp survives — unknown age is not old age",
    !isExpiredHubAlert({ from: "hub:duty", text: "x" }));
  ok("a malformed entry does not throw", !isExpiredHubAlert(null) && !isExpiredHubAlert(undefined));
}

console.log("\nthe real wedge, replayed at the ratio that was measured");
{
  // 44 expired hub alerts + 3 peer messages + 2 fresh hub alerts = the 49 held when the fix landed.
  const queue = [
    ...Array.from({ length: 44 }, (_, i) => msg("hub:duty", 22 * HOUR - i * 1000)),
    ...Array.from({ length: 3 }, () => msg("codex:stone-tracker", 21 * HOUR)),
    ...Array.from({ length: 2 }, () => msg("hub:duty", 2 * MIN)),
  ];
  const kept = queue.filter(m => !isExpiredHubAlert(m));
  ok("44 of 49 are shed", queue.length - kept.length === 44, `kept ${kept.length}`);
  ok("every peer message survives",
    kept.filter(m => m.from === "codex:stone-tracker").length === 3);
  ok("fresh hub alerts survive", kept.filter(m => m.from === "hub:duty").length === 2);
}

console.log("\nthe runner wires it where it matters");
{
  ok("shouldWake rejects an expired hub alert first", /function shouldWake\(message\) \{\s*\n\s*if \(isExpiredHubAlert\(message\)\)/.test(src));
  ok("the restore path filters broadcasts too", /restored\.bcast\.filter\(m => !isExpiredHubAlert\(m\)/.test(src));
  ok("the TTL is overridable for drills", /TRANTOR_HUB_ALERT_TTL_MS/.test(src));
  ok("a restart SAYS what it shed, so a shrinking queue is never silent",
    /dropped \$\{shed\} expired hub staleness alert/.test(src));
  ok("only hub:duty is ever expired — the narrowness is the safety property",
    /m\?\.from === "hub:duty" &&/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

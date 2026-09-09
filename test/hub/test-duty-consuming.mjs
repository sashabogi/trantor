#!/usr/bin/env node
// A heartbeat is not work: the hub must call duty DARK when it stops consuming.
//
// The deepest layer of the 2026-09-09 failure, and the one that made all the others survivable
// instead of self-healing. The hub already has the right instinct (#5686): when duty is dark, route
// escalations to the SENDER — the party who believes they were heard and is owed a reply — rather
// than queue them on a corpse. Had that armed, the orchestrator would have been told directly and
// the night would have cost minutes.
//
// It never armed, because `online` meant `lastSeen < DUTY_DARK_MS` and the runner's heartbeat IS
// its long-poll — which keeps running while the seat is parked on a quota failure. So a seat that
// held 48 escalations for 21.9 hours looked perfectly healthy to the hub the entire time.
//
// dutyQueuedEscalations() sat directly below that function computing the honest signal, unread.
// `deliveredUpTo` stops advancing the moment the seat stops working, so a backlog that is both
// LARGE and OLD is proof of a stuck seat no matter how briskly it polls.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};

const src = readFileSync(`${ROOT}/hub/duty.mjs`, "utf8");

// The predicate under test, mirrored. The source assertions at the bottom keep it in step with the
// hub, which cannot be imported without booting a server.
const MAX = 10, STUCK_MS = 30 * 60_000, DARK_MS = 5 * 60_000;
const liveness = ({ lastSeenMs, stuck, oldestStuckMs }) => {
  const beating = lastSeenMs < DARK_MS;
  const consuming = !(stuck >= MAX && oldestStuckMs >= STUCK_MS);
  return { online: beating && consuming, beating, consuming, stuck };
};

const MIN = 60_000, HOUR = 3.6e6;

console.log("\nthe incident: heartbeating briskly, consuming nothing");
{
  // The real shape: the long-poll kept the heartbeat fresh every few seconds for 21.9 hours while
  // 48 escalations went unread.
  const l = liveness({ lastSeenMs: 3000, stuck: 48, oldestStuckMs: 21.9 * HOUR });
  ok("the heartbeat is fine", l.beating);
  ok("but it is NOT consuming", !l.consuming);
  ok("so the hub calls it DARK — this is the whole fix", !l.online, JSON.stringify(l));
}

console.log("\na genuinely healthy seat stays online");
{
  const l = liveness({ lastSeenMs: 2000, stuck: 0, oldestStuckMs: 0 });
  ok("no backlog, fresh heartbeat → online", l.online);
}
{
  // Working through a burst: a big queue that is being consumed is not stuck, because the oldest
  // entry keeps getting young as deliveredUpTo advances.
  const l = liveness({ lastSeenMs: 2000, stuck: 40, oldestStuckMs: 90 * 1000 });
  ok("a LARGE but YOUNG backlog is a seat working, not a seat stuck", l.online);
}
{
  // A trickle that is old but tiny: below the count floor, so not yet proof of a wedge.
  const l = liveness({ lastSeenMs: 2000, stuck: 2, oldestStuckMs: 3 * HOUR });
  ok("an OLD but TINY backlog does not trip it — both conditions are required", l.online);
}

console.log("\na crashed seat is still dark, the old way");
{
  const l = liveness({ lastSeenMs: 10 * MIN, stuck: 0, oldestStuckMs: 0 });
  ok("no heartbeat → dark even with an empty queue", !l.online);
  ok("and it is reported as not beating, so the fix differs", !l.beating);
}

console.log("\nthe hub wires it, and says WHICH kind of dark");
{
  ok("online requires both beating AND consuming", /online: beating && consuming/.test(src));
  ok("consuming is derived from the unconsumed backlog",
    /const stuck = dutyQueuedEscalations\(\)/.test(src) && /oldestUnconsumedTs\(\)/.test(src));
  ok("both a count floor and an age floor are required",
    /stuck >= DUTY_STUCK_MAX && oldestStuckMs >= DUTY_STUCK_MS/.test(src));
  ok("the thresholds are tunable without a redeploy",
    /RELAY_DUTY_STUCK_MAX/.test(src) && /RELAY_DUTY_STUCK_MS/.test(src));
  ok("the dark event distinguishes stuck from crashed",
    /heartbeating but NOT CONSUMING/.test(src) && /has no heartbeat/.test(src));
  ok("oldestUnconsumedTs only counts messages past deliveredUpTo",
    /m\.to !== DUTY_SESSION \|\| m\.id <= upTo/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

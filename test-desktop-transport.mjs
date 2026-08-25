#!/usr/bin/env node
// The desktop app used to hand the operator reqwest's own words.
//
// 2026-08-25: the inbox showed "error decoding response body" in red. It reads like corrupt data and
// is not — reqwest says that when the BODY READ is interrupted, which is what happens to any request
// in flight when the hub restarts, i.e. on every deploy. Routine event, alarming message.
//
// This imports the REAL module (node strips the types), not a copy of it, because a drill that tests
// its own transcription of the logic proves nothing.
import { describeTransportFailure } from "./desktop/src/shared/api/transport-errors.ts";

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); } };
const HUB = "http://100.79.242.104:4477";

console.log("# desktop transport errors");

const restarted = describeTransportFailure("error decoding response body", HUB);
ok("the restart case says what happened, in words", /lost contact/i.test(restarted), restarted);
ok("…and does not repeat reqwest's phrasing at the operator", !/decoding response body/i.test(restarted), restarted);
ok("…and says it is retrying, so it does not read as a dead end", /retry/i.test(restarted), restarted);

ok("a timeout is named as a timeout, with the hub it timed out on",
  /did not answer/i.test(describeTransportFailure("operation timed out", HUB)) && describeTransportFailure("operation timed out", HUB).includes(HUB));
ok("an unreachable hub asks the two questions worth asking",
  /can't reach/i.test(describeTransportFailure("tcp connect error: Connection refused", HUB)));
ok("a DNS failure is distinguished from an unreachable host",
  /resolve/i.test(describeTransportFailure("dns error: failed to lookup address", HUB)));

// The rule that keeps this honest: never invent reassurance for a failure we do not recognise.
const weird = "some brand new failure nobody has seen";
ok("an UNRECOGNISED failure is passed through verbatim, never softened into a non-answer",
  describeTransportFailure(weird, HUB) === weird, describeTransportFailure(weird, HUB));

ok("matching is case-insensitive (the string comes from a library, not from us)",
  /lost contact/i.test(describeTransportFailure("Error Decoding Response Body", HUB)));

console.log(`\n${fail === 0 ? "✅" : "❌"} desktop transport: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

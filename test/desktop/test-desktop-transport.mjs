#!/usr/bin/env node
// Reqwest's "error decoding response body" can mean an interrupted body read during a hub restart,
// not corrupt data. Import the real module so the drill cannot diverge from it.
import { describeTransportFailure } from "../../desktop/src/shared/api/transport-errors.ts";

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); } };
const HUB = "http://100.64.0.10:4477";

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

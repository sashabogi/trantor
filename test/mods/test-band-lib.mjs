#!/usr/bin/env node
// #12091: the pure helpers behind the trantor-band pilot mod.
import {
  bandText, basename, contextFraction, contextPercent, contextRecord, handoffState,
  newestHandoffName, projectFromMarker, safeId,
} from "../../hooks/mods/band-lib.mjs";

let pass = 0, fail = 0;
const ok = (condition, name) => {
  condition ? pass++ : fail++;
  console.log(`  ${condition ? "✓" : "✗"} ${name}`);
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}${JSON.stringify(a) === JSON.stringify(b) ? "" : ` (got ${JSON.stringify(a)})`}`);

console.log("context fill");
eq(contextPercent({ tokens: 34000, window: 100000 }), 34, "34k of 100k is 34%");
eq(contextPercent({ tokens: 1, window: 3 }), 33, "rounds to a whole percent");
eq(contextPercent({ window: 200000 }), null, "no tokens yet (fresh session) is unknown, not 0%");
eq(contextPercent({ tokens: 5, window: 0 }), null, "a zero window is unknown");
eq(contextPercent(undefined), null, "a missing context is unknown");
eq(contextFraction({ tokens: 300000, window: 200000 }), 1, "fill is capped at 1");
eq(contextRecord({ tokens: 34000, window: 100000 }, 123), { ts: 123, tokens: 34000, window: 100000, frac: 0.34 }, "the context JSON shape");
eq(contextRecord({ window: 100000 }, 123), null, "no record is written while the fill is unknown");

console.log("ids and names");
eq(safeId("a1b2-c3.d4"), "a1b2-c3.d4", "a session id passes through");
eq(safeId("../../etc/x"), ".._.._etc_x", "path separators in an id cannot escape the directory");
eq(basename("/work/demo/"), "demo", "basename tolerates a trailing slash");
eq(projectFromMarker('{"id":"crm-platform"}'), "crm-platform", "the project marker id is read");
eq(projectFromMarker('{"id":"../x"}'), "", "a malformed marker id is refused");
eq(projectFromMarker("not json"), "", "a broken marker file is an empty id");

console.log("handoff file");
const names = ["demo-100.json", "demo-300.json", "demo-20.json", "demo-x.json", "demo-300.json.lock", "other-999.json", "demo2-999.json"];
eq(newestHandoffName(names, "demo"), "demo-300.json", "the newest numbered file of exactly this project");
eq(newestHandoffName(names, "nope"), "", "no file for another project");
eq(newestHandoffName(names, ""), "", "no project means no file");
eq(handoffState('{"consumed":true}', 1000), "", "a consumed handoff shows nothing");
eq(handoffState('{"consumed":false}', 1000), "pending", "an unconsumed handoff is pending");
eq(handoffState('{"claim":{"expiresAt":1500}}', 1000), "claimed", "an unexpired claim is claimed");
eq(handoffState('{"claim":{"expiresAt":900}}', 1000), "pending", "an expired claim is pending again");
eq(handoffState("garbage", 1000), "", "an unreadable record shows nothing");

console.log("band text");
eq(bandText({ percent: 34, handoff: "pending" }), "ctx 34% · handoff pending", "both parts");
eq(bandText({ percent: 34, handoff: "" }), "ctx 34%", "context only");
eq(bandText({ percent: null, handoff: "claimed" }), "handoff claimed", "handoff only");
eq(bandText({ percent: null, handoff: "" }), "", "nothing known draws nothing");
eq(bandText({ percent: 0, handoff: "" }), "ctx 0%", "0% is a real reading");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

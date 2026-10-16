#!/usr/bin/env node
// #11838 — a fixed usage window ("5-hour usage limit") gives the park a bound, and the queued
// log line never prints MAX_SAFE_INTEGER as seconds.
import { parseResetAt, queuedWording } from "../../lib/turn-policy.mjs";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("  FAIL " + n); } };
const now = 1_800_000_000_000;
const H = 3600e3;

ok("kimi's exact 5-hour text -> now + 5h",
  parseResetAt("403 You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.", now) === now + 5 * H);
ok("generalized 3-hour usage limit", parseResetAt("You hit the 3-hour usage limit", now) === now + 3 * H);
ok("'<N> hour limit' spelling", parseResetAt("reached your 8 hour limit", now) === now + 8 * H);
ok("no window -> unbounded (0)", parseResetAt("403 You've reached your usage limit.", now) === 0);
ok("a stated time still wins over the window", parseResetAt("5-hour usage limit, try again in 2 hours", now) === now + 2 * H);

const un = queuedWording(Number.MAX_SAFE_INTEGER, "exhausted", "kimi", 2, now);
ok("unbounded -> names trantor up, no number", /parked \(exhausted\) until `trantor up kimi`/.test(un) && !/\d{6,}/.test(un));
const b = queuedWording(now + 90e3, "exhausted", "kimi", 2, now);
ok("bounded -> clock time and seconds", /next attempt at .+ \(in 90s\)/.test(b));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

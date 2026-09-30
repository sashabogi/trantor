#!/usr/bin/env node
// #9724 drill — an OpenRouter billing rejection rode a clean exit to "✅ done": the specimen
// (.agent-bus-out/openrouter-402-stderr.txt, key URL masked) printed "requires more credits …
// can only afford 16" and opencode exited 0. The ledger row (.agent-bus-out/openrouter-402-row.json)
// carries verdict "classified success" over usage resolved to all zeros — no model work happened.
import {
  classifyFailure, verdictFor, looksLikeBillingDeath, BILLING_RE,
  usageSaysNoWork, zeroUsageVerdict,
} from "../../lib/classify-failure.mjs";
import { PARKING_REASONS } from "../../lib/turn-policy.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };

// The real stderr, key URL masked (no live provider calls — fixtures only).
const SPECIMEN = `Error: This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 16. To increase, visit https://openrouter.ai/workspaces/default/keys/MASKED and adjust the key's monthly limit`;
// The real turn row's shape: exit 0, output present, usage RESOLVED to all zeros (#8234 lookup).
const ROW = { exit: 0, effExit: 0, emptyOutput: false, emptyTurn: false, verdict: "classified success because exit 0 with CLI output", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const LONG_ANSWER = "Done — moved the classifier to lib/classify-failure.mjs, added the billing pattern, and the runner now lifts effExit on the specimen text. ".repeat(3);

console.log("# billing-exhausted — the OpenRouter 402 that exited 0 and posted done (#9724)");

console.log("\n## the real specimen classifies exhausted, never success");
{
  const { reason, matched } = classifyFailure(0, SPECIMEN);
  ok("classifyFailure(exit 0, specimen) is exhausted", reason === "exhausted", `${reason}: ${matched}`);
  ok("the matched evidence is the billing phrase", /requires more credits|can only afford/.test(matched), matched);
  const v = verdictFor(0, 0, false, SPECIMEN, false, false);
  ok("verdictFor(exit 0, exit 0, specimen) reads classified exhausted", v.startsWith("classified exhausted because"), v);
  ok("the verdict never says success", !/success/.test(v), v);
  ok("the old row's verdict string is exactly the bug this closes", v !== ROW.verdict, ROW.verdict);
  const v1 = verdictFor(0, 1, false, SPECIMEN, false, false);
  ok("the lifted-exit path names exhausted too", v1.startsWith("classified exhausted because"), v1);
  ok("HTTP 402 and insufficient balance classify exhausted",
    classifyFailure(0, "HTTP 402 payment required").reason === "exhausted"
    && classifyFailure(0, "insufficient balance for this request").reason === "exhausted");
}

console.log("\n## the exit-0 guard keeps the doctrine — real work and honest answers stand");
{
  ok("looksLikeBillingDeath sees the specimen", looksLikeBillingDeath(SPECIMEN) === true);
  ok("a shipped commit is real work — never re-labelled", looksLikeBillingDeath(SPECIMEN, true) === false);
  ok("an honest answer classifies success as before",
    verdictFor(0, 0, false, LONG_ANSWER, false, false) === ROW.verdict,
    verdictFor(0, 0, false, LONG_ANSWER, false, false));
  ok("a turn quoting no billing phrase never trips the guard", looksLikeBillingDeath(LONG_ANSWER) === false);
  ok("a box cut still outranks the quota family (#7099)",
    classifyFailure(141, SPECIMEN, false, false, true).reason === "cut-signal",
    classifyFailure(141, SPECIMEN, false, false, true).reason);
  ok("the kimi-era quota phrasing still classifies exhausted",
    classifyFailure(1, "you've reached your usage limit").reason === "exhausted");
}

console.log("\n## a long turn that QUOTES the phrases is work, not a billing death (#9812)");
{
  // kimi's 09-30 kickoff: 72s, exit 0, ran `git log`, and 58fc5e2's message names every phrase.
  const GIT_LOG = "58fc5e2 #9724: ... FIX: BILLING_RE + looksLikeBillingDeath in lib/classify-failure.mjs (requires more credits | can only afford | http 402 | insufficient balance | payment required); the runner lifts effExit";
  const KIMI_TURN = `• The contract scope is items 0, 1, 4 (runner half + RULES line). First, verify the base sha.\n$ git log --oneline -5\n${GIT_LOG}\n${LONG_ANSWER}`;
  ok("the kimi turn is not a billing death", looksLikeBillingDeath(KIMI_TURN) === false);
  ok("its verdict is success, never exhausted", verdictFor(0, 0, false, KIMI_TURN, false, false) === ROW.verdict,
    verdictFor(0, 0, false, KIMI_TURN, false, false));
  ok("the real 300-byte stderr still trips", looksLikeBillingDeath(`${SPECIMEN}\n${" ".repeat(30)}`) === true);
}

console.log("\n## a usage record RESOLVED to all zeros is never success; null stays unknown");
{
  ok("usageSaysNoWork(the row's zero record) is true", usageSaysNoWork(ROW.usage) === true, JSON.stringify(ROW.usage));
  ok("null usage stays unknown — never failure", usageSaysNoWork(null) === false && usageSaysNoWork(undefined) === false);
  ok("a record with real counts is not zero-work", usageSaysNoWork({ input: 128, output: 900, cacheRead: 0, cacheWrite: 0 }) === false);
  ok("the zero-usage verdict names zero-usage, never success",
    zeroUsageVerdict().startsWith("classified zero-usage because") && !/success/.test(zeroUsageVerdict()),
    zeroUsageVerdict());
}

console.log("\n## the reason parks the seat like the kimi exhausted path");
{
  ok("exhausted is a PARKING reason", PARKING_REASONS.has("exhausted"));
  ok("the billing regex carries every contract phrase",
    ["requires more credits", "can only afford", "http 402", "insufficient balance"].every(p => BILLING_RE.test(p)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

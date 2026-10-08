#!/usr/bin/env node
// #11389 drill — kimi turns that died on its 5-hour window read exhausted (with the reset line
// in the evidence), never "crashed, no known failure pattern". The fixture is the real err tail
// (7-day/weekly 403), masked. HONEST: the limit text has matched the quota regex since <= 09-29,
// so this replay is green on pre-fix code — the crashed turns' own text is asked on the card.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyFailure, verdictFor } from "../../lib/classify-failure.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };

const FIXTURE = fileURLToPath(new URL("./fixtures/kimi-quota-tail.txt", import.meta.url));
const TAIL = readFileSync(FIXTURE, "utf8");

console.log("# kimi-quota-tail — the kimi 403 usage-limit death reads exhausted, never crashed (#11389)");

console.log("\n## the fixture is the real tail, masked");
{
  ok("the fixture carries the kimi death banner",
    /error: failed to run prompt: provider\.auth_error: 403 /.test(TAIL), TAIL.split("\n").at(-2) || "");
  ok("the fixture carries the explicit limit text",
    /You've reached your weekly \(7-day\) usage limit\./.test(TAIL));
  ok("the fixture carries the reset line — the verdict evidence can name it",
    /quota will reset when the current 7-day window ends/.test(TAIL));
  ok("the mask held — no home path in the fixture", !/sashabogojevic/.test(TAIL));
}

console.log("\n## the replay: the runner's exact classify input is the capture tail (lastErrText = ownOut.slice(-4000))");
{
  const lastErrText = TAIL.slice(-4000);
  const { reason, matched } = classifyFailure(1, lastErrText);
  ok("classifyFailure(exit 1, tail) is exhausted", reason === "exhausted", `${reason}: ${matched}`);
  ok("the matched evidence is the limit phrase, never 'no known failure pattern'",
    /usage limit|reached your/.test(matched), matched);
  ok("never crashed", reason !== "crashed" && !/no known failure pattern/.test(matched), matched);
  const v = verdictFor(1, 1, false, lastErrText);
  ok("the verdict reads classified exhausted", v.startsWith("classified exhausted because"), v);
  ok("the verdict never says crashed or auth",
    !/crashed|classified auth\b/.test(v), v);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

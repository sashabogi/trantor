#!/usr/bin/env node
// #7063: preserve each work order's head and tail, including its card id, base and instructions.
// Cut the middle per message, never with a shared batch budget.
import { capWake } from "../../bin/crew-payload.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : ` — ${detail}`}`); cond ? pass++ : fail++; };

console.log("# trantor wake cap keeps head and tail (#7063)");

// ---- a 5000-char contract, shaped like a real work order ----
{
  const firstLine = "work order #7063: fix the wake cap, it eats a work order's instructions";
  const filler = "(rationale and evidence, the middle of the message) ".repeat(96);
  const closing = [
    "base: d63cb8c158db62ab5cbeaf1113cc0518f6e81b93",
    "Gate test/runner + test/crew from your commit, verified at <sha>, testing. Do not merge.",
    "Commit early so a box cut on a clean tree loses the turn, not the work.",
  ].join("\n");
  const body = `${firstLine}\n${filler}${closing}`;
  if (body.length <= 2000 || closing.length > 700) { console.log(`  fixture mis-sized: body=${body.length} closing=${closing.length}`); process.exit(1); }

  const got = capWake([{ from: "laptop:trantor", to: "glm:trantor", text: body }]);
  const text = got.text;
  ok("the message is over the cap and so was capped once", text.includes("chars of this message elided from the middle]"), text.length);
  ok("the FIRST LINE survives", text.includes(firstLine));
  ok("the base: line survives", text.includes("base: d63cb8c158db62ab5cbeaf1113cc0518f6e81b93"));
  ok("the LAST TWO SENTENCES survive", text.includes("Gate test/runner + test/crew from your commit, verified at <sha>, testing. Do not merge.")
    && text.includes("Commit early so a box cut on a clean tree loses the turn, not the work."));
  ok("the marker names how many chars were elided", text.includes(`${(body.length - 1200 - 700).toLocaleString("en-US")} chars of this message elided from the middle`));
  ok("the capped body is bounded near head+tail", text.length < 1200 + 700 + 200, `len=${text.length}`);
  ok("the metadata prefix is intact", text.startsWith("[laptop:trantor]: "));
}

// ---- a short contract is untouched, byte for byte ----
{
  const short = "small order: read the card, do the thing, end your turn";
  const got = capWake([{ from: "orch", to: "glm:trantor", text: short }]);
  ok("a short wake body passes through byte-identical, no marker", got.text === `[orch]: ${short}`);
}

// ---- the cap is PER MESSAGE, never a batch budget ----
{
  const batch = [
    { from: "a", to: "glm:t", text: "first order\n" + "m".repeat(4900) + "\ntail one: ship it today" },
    { from: "b", to: "glm:t", text: "second order\n" + "n".repeat(4900) + "\ntail two: report at five" },
  ];
  const got = capWake(batch);
  ok("both over-cap messages keep their own tail — the cap is not shared across the batch",
    got.text.includes("tail one: ship it today") && got.text.includes("tail two: report at five"), "");
  ok("each message carries its own elision marker", (got.text.match(/elided from the middle/g) || []).length === 2);
  ok("kept/total are unchanged by body capping", got.kept === 2 && got.total === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

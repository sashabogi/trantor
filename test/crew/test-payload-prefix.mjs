#!/usr/bin/env node
// The turn payload leads with the STABLE blocks, so provider prefix caching can engage (#8199).
//
// Every provider we hand these prompts to caches on an exact prefix match from token 0. DeepSeek is
// the bluntest about it: "Only requests with identical prefixes (starting from the 0th token) will
// be considered duplicates, and partial matches in the middle of the input will not trigger a cache
// hit." A hit bills around a tenth of a miss.
//
// composedTurn used to open with `base` — a git SHA that moves whenever anything lands on main —
// and then the per-turn wake, burying RULES (~3,300 chars) and lessons (capped at 16,000) at the
// end. Token 0 therefore differed on nearly every turn, nothing could ever cache, and roughly 4,800
// tokens of identical preamble were re-bought at full rate on every turn of every foreign-CLI seat:
// dsh, codex, kimi, and every opencode/BYOM seat. The operator's symptom was a Codex $100 plan
// spent in a day and a Qwen weekly quota in half a day, on work that used to fit comfortably.
//
// The state path had this written down the whole time — lib/state/assemble.mjs: "the bytes before
// STATE_DELIM are the caller's preamble and NOTHING else, or prefix caching never engages" — and it
// was never carried across to the seats that are not harness-assembled.
//
// What this suite pins: the stable head is byte-identical across turns, divergence begins no earlier
// than the first volatile section, and nothing the seat must FIND moved out of reach.
import { composePrompt, PAYLOAD_CAPS } from "../../bin/crew-payload.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
};

// The real section order, as bin/crew-runner.mjs composedTurn builds it.
const RULES = "Rules: you are glm:trantor on the trantor crew. ".repeat(70);      // ~3.3k, constant per seat
const LESSONS = "lesson: never reset onto main by hand. ".repeat(120);            // stable between lesson writes
// Shaped exactly as crew-runner's ordinary turn builds it: `base` is EMPTY on a normal turn and the
// sha rides inside `again`, which is why token 0 used to be the wake text itself.
const turn = ({ sha, wake, ctx = "ctx block", tail = "\nAct on what's addressed to you.\n" }) => composePrompt([
  { name: "rules", text: RULES, trim: "drop", order: 3 },
  { name: "lessons", text: LESSONS, trim: "drop", order: 2 },
  { name: "ctx", text: ctx, trim: "drop", order: 1 },
  { name: "tail", text: tail },
  { name: "again", text: `\nbase: ${sha}\n` },
  { name: "base", text: "" },
  { name: "wake", text: wake, trim: "truncate", order: 4 },
]).prompt;

const sharedPrefix = (a, b) => { let i = 0; while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++; return i; };

console.log("\nthe stable head survives a changed wake and a moved base");
{
  const a = turn({ sha: "aaaaaaa", wake: "Contract: card #1, yours." });
  const b = turn({ sha: "bbbbbbb", wake: "Contract: card #9999, different work entirely, much longer text here." });
  const shared = sharedPrefix(a, b);
  const stable = RULES.length + LESSONS.length;

  ok("the whole RULES+lessons block is shared byte-for-byte", shared >= stable, `shared ${shared} < stable ${stable}`);
  ok("…which is thousands of characters, not a handful", shared > 3000, `shared ${shared}`);
  ok("divergence starts at the volatile part, not inside the stable one",
    a.slice(0, shared).includes("Rules: you are") && a.slice(0, shared).includes("lesson:"), `prefix ${shared}c`);

  // THE REGRESSION GUARD. This is the old order; it must NOT produce a usable shared prefix.
  const oldOrder = ({ sha, wake }) => composePrompt([
    { name: "base", text: "" },
    { name: "wake", text: wake, trim: "truncate", order: 4 },
    { name: "ctx", text: "ctx block", trim: "drop", order: 1 },
    { name: "again", text: `\nbase: ${sha}\n` },
    { name: "rules", text: RULES, trim: "drop", order: 3 },
    { name: "lessons", text: LESSONS, trim: "drop", order: 2 },
  ]).prompt;
  const oa = oldOrder({ sha: "aaaaaaa", wake: "Contract: card #1, yours." });
  const ob = oldOrder({ sha: "bbbbbbb", wake: "Contract: card #9999, different work entirely, much longer text here." });
  const oldShared = sharedPrefix(oa, ob);
  // Not zero: two contracts both open "Contract: card #", so a dozen-odd bytes match by accident.
  // That is the point — an accidental boilerplate overlap is not a cache, it is noise. What matters
  // is that the old order never reached the constant block at all.
  ok("the OLD order never cached the constant block — the bug, pinned",
    oldShared < RULES.length / 10, `old shared ${oldShared}c vs RULES ${RULES.length}c`);
  ok("…so the fix is worth orders of magnitude, not a rounding error", shared / Math.max(1, oldShared) > 100,
    `new ${shared} vs old ${oldShared}`);
}

console.log("\na changed BASE alone still keeps the whole stable head");
{
  const a = turn({ sha: "1111111", wake: "same wake" });
  const b = turn({ sha: "2222222", wake: "same wake" });
  ok("moving main does not cost the cache", sharedPrefix(a, b) >= RULES.length + LESSONS.length);
}

console.log("\nnothing the seat must FIND moved out of reach");
{
  const p = turn({ sha: "deadbee", wake: "Contract: card #42, yours. Do the thing." });
  ok("the base: line is still present and matchable", /^\s*base:\s*deadbee\b/m.test(p));
  ok("the wake is still present", p.includes("card #42"));
  ok("the ask lands LAST, which is what a work order wants (#7063)", p.trimEnd().endsWith("Do the thing."), JSON.stringify(p.slice(-40)));
  ok("…and token 0 is the constant, which is the whole point", p.slice(0, 14) === "Rules: you are", JSON.stringify(p.slice(0, 20)));
  ok("rules lead the payload", p.startsWith("Rules: you are"));
}

console.log("\nthe trim ladder is unchanged — losing the instruction is worse than losing the cache");
{
  // Bust the total cap; wake carries order 4 so it is trimmed LAST, after ctx, lessons and rules.
  const huge = "x".repeat(PAYLOAD_CAPS.totalChars);
  const built = composePrompt([
    { name: "rules", text: RULES, trim: "drop", order: 3 },
    { name: "lessons", text: LESSONS, trim: "drop", order: 2 },
    { name: "ctx", text: huge, trim: "drop", order: 1 },
    { name: "base", text: "base: abc1234" },
    { name: "wake", text: "Contract: card #7, yours.", trim: "truncate", order: 4 },
  ]);
  ok("over the cap, the instruction survives", built.prompt.includes("card #7"), built.dropped.join("; "));
  ok("…and ctx is what went first", /ctx/.test(built.dropped.join(" ")), built.dropped.join("; "));
}

console.log(fail ? `\n${pass} passed, ${fail} FAILED` : `\nALL PASS (${pass})`);
process.exit(fail ? 1 : 0);

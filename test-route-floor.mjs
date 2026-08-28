#!/usr/bin/env node
// trantor difficulty-router floor tests (#5482).
// Hard never routes flash/turbo/lite/mini/highspeed/small when a stronger candidate
// exists. Falls back to the full list only when the floor would empty it.
// Easy/medium are unchanged. The regex catches each tier word.
import { scroogeModelFor } from "./bin/advise.mjs";

let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${name}`); };

const registry = {
  models: {
    "claude-opus-4":        { cost_in: 15, cost_out: 75, good_for: ["code"] },
    "claude-sonnet-4":      { cost_in: 3, cost_out: 15, good_for: ["code"] },
    "deepseek-v4-flash":    { cost_in: 0.14, cost_out: 0.28, good_for: ["code"] },
    "deepseek-v3-turbo":    { cost_in: 0.10, cost_out: 0.20, good_for: ["code"] },
    "kimi-k2":              { cost_in: 0.50, cost_out: 1.00, good_for: ["code"] },
    "openai-gpt-4o":        { cost_in: 2.50, cost_out: 10.00, good_for: ["code"] },
    "openai-o3-mini":       { cost_in: 0.30, cost_out: 1.20, good_for: ["code"] },
    "anthropic-claude-3.5-haiku": { cost_in: 0.25, cost_out: 1.00, good_for: ["code"] },
  },
};

const caps = {
  "claude-opus-4":        { coding: 95 },
  "claude-sonnet-4":      { coding: 80 },
  "deepseek-v4-flash":    { coding: 50 },
  "deepseek-v3-turbo":    { coding: 45 },
  "kimi-k2":              { coding: 70 },
  "openai-gpt-4o":        { coding: 90 },
  "openai-o3-mini":       { coding: 30 },
  "anthropic-claude-3.5-haiku": { coding: 60 },
};

console.log("# route floor tests");

// Hard excludes flash-tier when stronger candidates exist
const hardStrong = scroogeModelFor(registry, caps, "code", "hard");
ok(hardStrong && !/(flash|turbo|lite|mini|highspeed|small)/i.test(hardStrong.model),
  `hard routes to strong model, got ${hardStrong?.model}`);
ok(hardStrong?.model !== "deepseek-v4-flash",
  `hard does not pick deepseek-v4-flash when stronger exists`);
ok(hardStrong?.model !== "deepseek-v3-turbo",
  `hard does not pick deepseek-v3-turbo when stronger exists`);

// Hard falls back to flash when it is ALL there is
const flashOnly = {
  models: { "deepseek-v4-flash": { cost_in: 0.14, cost_out: 0.28, good_for: ["code"] } },
};
const capsFlash = { "deepseek-v4-flash": { coding: 60 } };
const hardFlashOnly = scroogeModelFor(flashOnly, capsFlash, "code", "hard");
ok(hardFlashOnly?.model === "deepseek-v4-flash",
  `hard falls back to flash when it is the only candidate`);

// Easy is untouched (may pick cheap flash)
const easy = scroogeModelFor(registry, caps, "code", "easy");
ok(easy !== null, "easy returns a model");

// Medium is untouched
const medium = scroogeModelFor(registry, caps, "code", "medium");
ok(medium !== null, "medium returns a model");

// The regex catches each tier word individually
const tierWords = ["flash", "turbo", "lite", "mini", "highspeed", "small"];
for (const w of tierWords) {
  const modelId = `test-model-${w}`;
  const testRegistry = { models: { [modelId]: { cost_in: 0.1, cost_out: 0.2, good_for: ["code"] } } };
  const testCaps = { [modelId]: { coding: 50 } };
  const result = scroogeModelFor(testRegistry, testCaps, "code", "hard");
  ok(result === null || !/(flash|turbo|lite|mini|highspeed|small)/i.test(result.model),
    `regex catches "${w}" in model id`);
}

// Hard with mixed list: flash + strong → picks strong (cheapest strong)
const mixed = {
  models: {
    "deepseek-v4-flash": { cost_in: 0.14, cost_out: 0.28, good_for: ["code"] },
    "claude-sonnet-4":   { cost_in: 3, cost_out: 15, good_for: ["code"] },
  },
};
const capsMixed = {
  "deepseek-v4-flash": { coding: 50 },
  "claude-sonnet-4":   { coding: 80 },
};
const hardMixed = scroogeModelFor(mixed, capsMixed, "code", "hard");
ok(hardMixed?.model === "claude-sonnet-4",
  `hard picks cheapest strong model over cheaper flash`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
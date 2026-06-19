#!/usr/bin/env node
// East Radar delta-engine tests — the "are we missing this" gate. Hermetic: pure functions only,
// no hub, no network, no filesystem state (computeDelta/renderDigest take state as an argument).
import { computeDelta, renderDigest } from "./bin/east-radar.mjs";

let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); cond ? pass++ : fail++; };
console.log("# east-radar tests");

const base = { updated: "2026-06-01", seen: { "qwen-3": { title: "Qwen 3", scope: "models" } }, carded: [] };
const cands = [
  { key: "deepseek-v4", scope: "models", title: "DeepSeek V4", significance: 9, url: "u1", what: "w", why: "y", west: "x" },
  { key: "qwen-3",      scope: "models", title: "Qwen 3 (dup)", significance: 9 },          // already seen → drop
  { key: "minor-thing", scope: "tooling", title: "minor", significance: 3 },                // below threshold → drop
  { key: "glm-5",       scope: "policy",  title: "GLM-5 policy move", significance: 7 },
];

const { fresh, next, droppedSeen, droppedWeak } = computeDelta(cands, base, 6);
ok("keeps only NEW + material items", fresh.length === 2);
ok("drops an already-seen key (the delta gate)", droppedSeen === 1 && !fresh.some(f => f.key === "qwen-3"));
ok("drops a below-threshold item", droppedWeak === 1 && !fresh.some(f => f.key === "minor-thing"));
ok("sorts by significance desc", fresh[0].key === "deepseek-v4");
ok("new keys fold into next baseline", next.seen["deepseek-v4"] && next.seen["glm-5"]);
ok("old baseline preserved", next.seen["qwen-3"]);

// idempotency: re-running the same candidates against the UPDATED baseline yields nothing new
const again = computeDelta(cands, next, 6);
ok("re-run is a no-op (idempotent — won't re-report)", again.fresh.length === 0 && again.droppedSeen === 3);

// unknown scope normalizes to models; missing key falls back to title slug
const odd = computeDelta([{ title: "No Key Item", scope: "bogus", significance: 8 }], { seen: {} }, 6);
ok("unknown scope → models; title→key fallback", odd.fresh.length === 1 && odd.fresh[0].scope === "models" && odd.fresh[0].key === "no-key-item");

// quiet run: empty candidates → empty delta (a valid, honest result)
ok("empty candidates → quiet run", computeDelta([], base, 6).fresh.length === 0);

const md = renderDigest("2026-06-19", fresh);
ok("digest groups by scope with headers", md.includes("## Frontier models & research") && md.includes("## Policy & industry"));
ok("digest carries the editor's-note placeholder for the agent", /Editor's note/.test(md));
ok("digest renders item + west contrast + source", md.includes("DeepSeek V4") && md.includes("West contrast:") && md.includes("[source](u1)"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
